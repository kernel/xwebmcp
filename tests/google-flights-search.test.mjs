import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { El, card as makeCard, segment, plusDays, longDate, validate } from "./google-flights-dom.mjs";

const source = readFileSync(new URL("../domains/google.com/search_flights.js", import.meta.url), "utf8");
const departDate = new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 10);
const returnDate = new Date(Date.now() + 28 * 86400000).toISOString().slice(0, 10);
const oneWay = { origin: "CVG", destination: "SFO", depart_date: departDate, trip_type: "one_way" };
const roundTrip = { ...oneWay, return_date: returnDate, trip_type: "round_trip" };
const TOOLS = ["get_page_context", "search_flights", "list_flights", "select_flight", "show_more_flights", "set_results_view", "set_flight_sort", "set_flight_filters", "get_flight_details"];

const card = options => makeCard({ date: departDate, ...options });

// A static Google Flights results page with Google's controls: Best/Cheapest tabs, the sort button, filter chips and
// 'View more flights'. Clicking a tab selects it, completes a results request and re-announces the list.
function resultsPage({ live = "2 results returned.", roundTripCards = false, extraCard = null, currencyName = "US dollars", firstCard = null, selectedView = "best", tabs = true, stopsChip = null } = {}) {
  const cardA = firstCard ?? card({ currencyName,
    dep: "6:08 PM", arr: "8:45 PM", airline: "Delta", duration: "5 hr 37 min",
    from: "CVG Cincinnati/Northern Kentucky International Airport", to: "SFO San Francisco International Airport",
    stops: 0, price: "$314", roundTrip: roundTripCards, emissions: "245 kg CO2e", comparison: "-19% emissions",
    segments: [segment({ from: "CVG", fromName: "Cincinnati/Northern Kentucky International Airport", dep: "6:08 PM", to: "SFO", toName: "San Francisco International Airport", arr: "8:45 PM", travel: "5 hr 37 min", airline: "Delta", number: "DL 1234", aircraft: "Boeing 737" })],
  });
  const cardB = card({
    dep: "4:32 PM", arr: "12:15 AM", plus: "+1", arrivalDate: plusDays(departDate, 1), airline: "United", operatedBy: "SkyWest DBA United Express",
    partners: "Lufthansa, Air Canada", duration: "10 hr 43 min", currencyName,
    from: "CVG Cincinnati/Northern Kentucky International Airport", to: "SFO San Francisco International Airport",
    stops: 1, layoverLabel: "Layover (1 of 1) is a 4 hr 42 min layover at Denver International Airport in Denver. ", layoverSummary: "4 hr 42 min layoverLong layover", price: "$1,245", roundTrip: roundTripCards, emissions: "1,416 kg CO2e", comparison: "Avg emissions",
    segments: [
      segment({ from: "CVG", fromName: "Cincinnati/Northern Kentucky International Airport", dep: "4:32 PM", to: "DEN", toName: "Denver International Airport", arr: "5:47 PM", travel: "3 hr 15 min", airline: "United", number: "UA 5595", aircraft: "Embraer 175", operator: "SkyWest DBA United Express", layover: "4 hr 42 min layoverDenver (DEN)" }),
      segment({ from: "DEN", fromName: "Denver International Airport", dep: "10:29 PM", to: "SFO", toName: "San Francisco International Airport", arr: "12:15 AM", plus: "+1", travel: "2 hr 46 min", airline: "United", number: "UA 2106", aircraft: "Airbus A321neo" }),
    ],
  });
  const hiddenDuplicate = card({ dep: "1:00 AM", arr: "2:00 AM", airline: "Ghost", duration: "1 hr", from: "CVG X", to: "SFO Y", stops: 0, price: "$1", emissions: "1 kg CO2e", comparison: "Avg emissions", segments: [], hidden: true });
  const liveRegion = new El("div", { attrs: { "aria-live": "polite" }, text: live });
  const moreButton = new El("button", { attrs: { "aria-label": "View more flights", "aria-expanded": "false" } });
  const otherList = new El("ul", { children: [cardB] });
  if (extraCard) {
    extraCard.hidden = true;
    otherList.append(extraCard);
    moreButton.onclick = () => { extraCard.hidden = false; moreButton.hidden = true; liveRegion.text = "3 results returned."; };
  } else moreButton.hidden = true;
  const tabNodes = tabs ? ["Best", "Cheapest"].map(name => new El("div", { attrs: { role: "tab", "aria-selected": String(name.toLowerCase() === selectedView) }, text: name })) : [];
  const observers = new Set();
  const fetched = () => { for (const o of observers) o.callback({ getEntries: () => [{ name: "https://www.google.com/_/FlightsFrontendUi/data/travel.frontend.flights.FlightsFrontendService/GetShoppingResults", startTime: Date.now() }] }); };
  for (const tab of tabNodes) tab.onclick = () => { for (const t of tabNodes) t.setAttribute("aria-selected", String(t === tab)); liveRegion.text = ""; setTimeout(() => { fetched(); liveRegion.text = live; }, 50); };
  const body = new El("body", { children: [
    liveRegion,
    new El("div", { children: tabNodes }),
    new El("div", { children: [new El("button", { attrs: { "aria-label": stopsChip ? `${stopsChip}, Stops, Selected` : "Stops, Not selected" } }), new El("button", { attrs: { "aria-label": "Airlines, Not selected" } })] }),
    new El("button", { attrs: { "aria-label": "Sorted by top flights, Change sort order." } }),
    new El("div", { children: [new El("h3", { text: roundTripCards ? "Top departing flights" : "Top flights" }), new El("ul", { children: [cardA] })] }),
    new El("div", { children: [new El("h3", { text: "Price insights" }), new El("span", { text: "Prices are currently typical" })] }),
    new El("div", { children: [new El("h3", { text: roundTripCards ? "Other departing flights" : "Other flights" }), otherList, moreButton] }),
    new El("ul", { hidden: true, children: [hiddenDuplicate] }),
    new El("p", { text: "Prices include required taxes + fees for 1 adult. Optional charges and bag fees may apply." }),
  ] });
  const documentElement = new El("html", { children: [body] });
  return {
    documentElement, body, querySelector: s => documentElement.querySelector(s), querySelectorAll: s => documentElement.querySelectorAll(s),
    modelContext: { getTools: async () => TOOLS.map(name => ({ name: `custom.ct_x.${name}` })) },
    cards: { a: cardA, b: cardB }, moreButton, tabs: tabNodes, observers,
  };
}

function harness({ startUrl = "https://www.google.com/travel/flights?hl=en", document = resultsPage(), consent = false, sorry = false, matches, fastClock = false, onNavigate = () => {} } = {}) {
  const calls = [];
  let url = startUrl;
  let tabId = "target-a";
  const resultsHost = sorry ? "https://www.google.com/sorry/index?continue=x" : null;
  const pageGlobals = () => {
    const location = new URL(url);
    let offset = 0;
    const PerformanceObserver = class { constructor(callback) { this.callback = callback; } observe() { document.observers?.add(this); } disconnect() { document.observers?.delete(this); } };
    const globals = { document, location, navigator: {}, setTimeout, Date, URL, atob, btoa, TextEncoder, TextDecoder, PerformanceObserver, performance: { now: () => Date.now() } };
    // Advances 30 s per reading so quiet periods and timeouts pass instantly.
    if (fastClock) globals.Date = class extends Date { static now() { offset += 30000; return Date.now() + offset; } };
    return globals;
  };
  const tools = vm.runInNewContext(`(${source}\n)`, {
    URL, URLSearchParams, btoa,
    currentTab: async () => ({ targetId: tabId }),
    switchTab: async target => { calls.push(`switchTab:${target}`); tabId = target; },
    pageInfo: async () => ({ url }),
    gotoUrl: async next => {
      calls.push(`goto:${next}`);
      url = consent ? `https://consent.google.com/m?continue=${encodeURIComponent(next)}` : resultsHost ?? next;
      onNavigate(next);
    },
    waitForElement: async (selector, options) => { calls.push(`wait:${selector}:${options.state}`); return true; },
    waitForNetworkIdle: async () => { calls.push("idle"); return true; },
    js: async (fn, options) => {
      calls.push("js");
      const value = await vm.runInNewContext(`(${fn.toString()})`, pageGlobals())(options?.arg);
      if (consent && /consent\.google\.com/.test(url) && value === true) url = new URL(url).searchParams.get("continue");
      return value;
    },
  });
  // JSON round-trip: results come from another vm realm, whose arrays fail deepEqual.
  const execute = async (input, context) => {
    const out = JSON.parse(JSON.stringify(await tools[0].execute(input, context)));
    validate(tools[0].tool.outputSchema, out);
    return out;
  };
  return { tools, execute, calls, currentUrl: () => url };
}
const emptyPage = () => { const doc = resultsPage({ live: "No results returned." }); for (const list of doc.querySelectorAll("ul")) list.hidden = true; return doc; };
const clicked = document => document.querySelectorAll("*").filter(e => e.clicks).length;

test("source is a self-contained expression with narrow Google Travel matching and typed snake_case schemas", () => {
  const { tools } = harness();
  assert.equal(tools.length, 1);
  const [definition] = tools;
  assert.equal(definition.kind, "cdp");
  assert.deepEqual(Array.from(definition.match.url_patterns), ["https://google.com/travel/*", "https://*.google.com/travel/*"]);
  assert.equal(definition.tool.name, "search_flights");
  const input = definition.tool.inputSchema;
  assert.deepEqual(Array.from(input.required), ["origin", "destination", "depart_date", "trip_type"]);
  assert.deepEqual(Array.from(input.properties.view.enum), ["best", "cheapest"]);
  assert.deepEqual([input.properties.max_stops.minimum, input.properties.max_stops.maximum, input.properties.passengers.maximum], [0, 2, 9]);
  assert.equal(input.properties.maxResults, undefined);
  assert.deepEqual(Array.from(input.properties.cabin.enum), ["economy", "premium_economy", "business", "first"]);
  assert.equal(definition.tool.outputSchema.properties.flights.items.properties.price.properties.amount.type, "number");
});

for (const [name, input, pattern] of [
  ["lowercase airport code", { ...oneWay, origin: "cvg" }, /IATA/],
  ["identical airports", { ...oneWay, destination: "CVG" }, /must differ/],
  ["past departure", { ...oneWay, depart_date: "2020-01-01" }, /in the past/],
  ["impossible date", { ...oneWay, depart_date: `${departDate.slice(0, 4)}-02-30` }, /real YYYY-MM-DD/],
  ["return before departure", { ...roundTrip, return_date: plusDays(departDate, -1) }, /on or after depart_date/],
  ["round trip without return", { ...oneWay, trip_type: "round_trip" }, /requires a real YYYY-MM-DD return_date/],
  ["one way with return", { ...oneWay, return_date: returnDate }, /must omit return_date/],
  ["too many passengers", { ...oneWay, passengers: 10 }, /1–9 adults/],
  ["unknown cabin", { ...oneWay, cabin: "coach" }, /cabin must be/],
  ["bad currency", { ...oneWay, currency: "us$" }, /currency must be/],
  ["unknown view", { ...oneWay, view: "fastest" }, /view must be best or cheapest/],
  ["zero limit", { ...oneWay, limit: 0 }, /limit must be/],
  ["legacy camelCase input", { origin: "CVG", destination: "SFO", departDate, tripType: "one_way" }, /snake_case/],
  ["legacy maxResults", { ...oneWay, maxResults: 5 }, /unexpected input maxResults/],
  ["negative stop limit", { ...oneWay, max_stops: -1 }, /max_stops must be/],
  ["unsupported stop limit", { ...oneWay, max_stops: 3 }, /max_stops must be/],
  ["fractional stop limit", { ...oneWay, max_stops: 0.5 }, /max_stops must be/],
  ["string stop limit", { ...oneWay, max_stops: "0" }, /max_stops must be/],
  ["null stop limit", { ...oneWay, max_stops: null }, /max_stops must be/],
]) {
  test(`invalid input (${name}) is refused before navigating or clicking, with the current page's actions`, async () => {
    const doc = resultsPage();
    const h = harness({ document: doc, startUrl: "https://www.google.com/travel/flights/search?tfs=x", fastClock: true });
    const result = await h.execute(input);
    assert.equal(result.status, "invalid_input");
    assert.match(result.message, /^INVALID_INPUT: /);
    assert.match(result.message, pattern);
    assert.equal(result.results_url, "");
    assert.ok(!h.calls.some(c => c.startsWith("goto:")));
    assert.equal(clicked(doc), 0);
    assert.ok(result.available_actions.some(a => a.tool === "search_flights"));
  });
}

test("invalid input on a page that cannot be read reports its controls as unknown and suggests only a new search", async () => {
  const h = harness({ startUrl: "https://example.com/" });
  const result = await h.execute({ ...oneWay, origin: "cvg" });
  assert.equal(result.status, "invalid_input");
  assert.deepEqual([result.page, result.view, result.sort, result.filters, result.results], [null, null, null, null, null]);
  assert.deepEqual(result.registered_tools, { known: false, names: [] });
  assert.deepEqual(result.available_actions.map(a => [a.tool, a.registered, a.input]), [["search_flights", null, null]]);
  assert.deepEqual(h.calls, []);
});

test("deep link encodes the query as Google's tfs protobuf with locale and currency", async () => {
  const h = harness({ document: emptyPage() });
  await h.execute({ origin: "CVG", destination: "SFO", depart_date: departDate, trip_type: "one_way", passengers: 2, cabin: "business", currency: "EUR" });
  const target = new URL(h.calls.find(c => c.startsWith("goto:")).slice(5));
  assert.equal(target.origin + target.pathname, "https://www.google.com/travel/flights/search");
  assert.equal(target.searchParams.get("hl"), "en");
  assert.equal(target.searchParams.get("gl"), "US");
  assert.equal(target.searchParams.get("curr"), "EUR");
  assert.equal(target.searchParams.get("tfu"), null);
  const tfs = Buffer.from(target.searchParams.get("tfs"), "base64url");
  // Live-verified layout: one leg (field 3), two adult passengers (field 8), business seat (field 9), one-way trip (field 19).
  const leg = Buffer.concat([Buffer.from([0x12, 10]), Buffer.from(departDate), Buffer.from([0x6a, 7, 0x08, 1, 0x12, 3]), Buffer.from("CVG"), Buffer.from([0x72, 7, 0x08, 1, 0x12, 3]), Buffer.from("SFO")]);
  assert.deepEqual(tfs, Buffer.concat([Buffer.from([0x1a, leg.length]), leg, Buffer.from([0x40, 1, 0x40, 1, 0x48, 3, 0x98, 1, 2])]));
});

for (const max_stops of [0, 1, 2]) {
  for (const input of [oneWay, roundTrip]) {
    test(`${input.trip_type} encodes max_stops=${max_stops} (Google's Stops filter) on every leg before navigation`, async () => {
      const h = harness({ document: emptyPage() });
      await h.execute({ ...input, max_stops });
      const tfs = Buffer.from(new URL(h.calls.find(c => c.startsWith("goto:")).slice(5)).searchParams.get("tfs"), "base64url");
      const leg = (day, from, to) => {
        const payload = Buffer.concat([Buffer.from([0x12, 10]), Buffer.from(day), Buffer.from([0x28, max_stops, 0x6a, 7, 0x08, 1, 0x12, 3]), Buffer.from(from), Buffer.from([0x72, 7, 0x08, 1, 0x12, 3]), Buffer.from(to)]);
        return Buffer.concat([Buffer.from([0x1a, payload.length]), payload]);
      };
      const legs = [leg(departDate, "CVG", "SFO")];
      if (input.trip_type === "round_trip") legs.push(leg(returnDate, "SFO", "CVG"));
      assert.deepEqual(tfs, Buffer.concat([...legs, Buffer.from([0x40, 1, 0x48, 1, 0x98, 1, input.trip_type === "round_trip" ? 1 : 2])]));
    });
  }
}

test("round trips encode a reversed second leg and the round-trip marker", async () => {
  const h = harness({ document: emptyPage() });
  await h.execute(roundTrip);
  const tfs = Buffer.from(new URL(h.calls.find(c => c.startsWith("goto:")).slice(5)).searchParams.get("tfs"), "base64url");
  const legs = [...tfs.toString("latin1").matchAll(/\x1a\x1e\x12\x0a(\d{4}-\d{2}-\d{2})j\x07\x08\x01\x12\x03([A-Z]{3})r\x07\x08\x01\x12\x03([A-Z]{3})/g)].map(m => m.slice(1));
  assert.deepEqual(legs, [[departDate, "CVG", "SFO"], [returnDate, "SFO", "CVG"]]);
  assert.deepEqual([...tfs.subarray(-5)], [0x48, 1, 0x98, 1, 1]);
});

for (const startUrl of ["https://www.google.com/travel/flights?hl=en", "https://www.google.com/travel/hotels", "https://www.google.com/", "https://example.com/", "about:blank"]) {
  test(`always navigates to a fresh search from ${startUrl}`, async () => {
    const h = harness({ startUrl });
    const result = await h.execute(oneWay);
    assert.equal(result.status, "ok");
    assert.equal(h.calls.filter(c => c.startsWith("goto:")).length, 1);
    assert.equal(h.calls.indexOf("js"), 0);
    assert.ok(h.calls.indexOf("wait:html:not([data-xwebmcp-stale]):attached") > h.calls.findIndex(c => c.startsWith("goto:")));
    assert.ok(!h.calls.includes("idle"));
  });
}

test("switches to the matched tab when the REPL is attached elsewhere", async () => {
  const h = harness();
  const result = await h.execute(oneWay, { matches: [{ top_target_id: "target-b" }] });
  assert.equal(result.status, "ok");
  assert.equal(h.calls[0], "switchTab:target-b");
  const same = harness();
  await same.execute(oneWay, { matches: [{ top_target_id: "target-a" }] });
  assert.ok(!same.calls.some(c => c.startsWith("switchTab")));
});

test("returns Google's initial rows in page order with sections, prices, layovers and overnight arrivals, opening nothing", async () => {
  const doc = resultsPage();
  const h = harness({ document: doc });
  const result = await h.execute(oneWay);
  assert.equal(result.status, "ok");
  assert.equal(clicked(doc), 0);
  assert.deepEqual(result.view.active, "best");
  assert.equal(result.view_clicked, false);
  assert.deepEqual(result.results.sections, [{ heading: "Top flights", first_position: 1, rows: 1 }, { heading: "Other flights", first_position: 2, rows: 1 }]);
  assert.deepEqual([result.results.rendered_rows, result.results.returned_rows, result.results.next_offset], [2, 2, null]);
  assert.equal(result.results.price_insight, "Prices are currently typical");
  assert.match(result.results.pricing_note, /^Prices include required taxes \+ fees for 1 adult/);
  assert.deepEqual(result.warnings, []);
  assert.equal(h.currentUrl(), result.results_url);
  const [a, b] = result.flights;
  assert.deepEqual(JSON.parse(Buffer.from(a.selection_ref.split(".")[1], "base64url").toString("utf8")), {
    v: 1, search: { trip: "one_way", legs: [[departDate, "CVG", "SFO"]], pax: [1], cabin: 1 }, leg: "departing", outbound: null,
    itinerary: [["CVG", departDate, "SFO", "DL", "1234"]], departure: `${departDate}T18:08`, arrival: `${departDate}T20:45`, price: [314, "US dollars"],
  });
  assert.deepEqual([a.position, a.section, a.detail_level, a.airlines, a.flight_numbers, a.departure_time, a.arrival_time, a.arrival_day_offset, a.duration_minutes, a.stops, a.emissions_kg_co2e, a.emissions_vs_typical_percent],
    [1, "Top flights", "summary", ["Delta"], ["DL 1234"], "18:08", "20:45", 0, 337, 0, 245, -19]);
  assert.deepEqual(a.price, { amount: 314, currency: "USD", currency_label: "US dollars", display_text: "$314", scope: "one_way", basis: "one_way_total", passengers_included: 1 });
  assert.deepEqual(a.segments[0], { marketing_carrier_code: "DL", flight_number: "DL 1234", airline: null, operated_by: null, aircraft: null, cabin: null, features: null, departure_airport: "CVG", departure_date: departDate, departure_time: "18:08", arrival_airport: "SFO", arrival_date: departDate, arrival_time: "20:45", duration_minutes: 337 });
  assert.deepEqual([b.position, b.section, b.partner_airlines, b.operated_by, b.flight_numbers, b.arrival_date, b.arrival_day_offset, b.arrival_time, b.price.amount, b.emissions_kg_co2e, b.emissions_vs_typical_percent],
    [2, "Other flights", ["Lufthansa", "Air Canada"], "SkyWest DBA United Express", ["UA 5595", "UA 2106"], plusDays(departDate, 1), 1, "00:15", 1245, 1416, 0]);
  assert.deepEqual(b.layovers, [{ airport: "DEN", airport_name: "Denver International Airport", city: "Denver", duration_minutes: 282, change_of_airport_to: null }]);
  assert.deepEqual(b.segments.map(s => [s.flight_number, s.departure_time, s.arrival_time]), [["UA 5595", "16:32", null], ["UA 2106", null, "00:15"]]);
  assert.deepEqual(result.available_actions.find(a => a.tool === "get_flight_details").input, { selection_ref: a.selection_ref });
});

test("round-trip searches report whole-trip totals and the departing-flight sections", async () => {
  const h = harness({ document: resultsPage({ roundTripCards: true }) });
  const result = await h.execute({ ...roundTrip, passengers: 2 });
  assert.equal(result.status, "ok");
  assert.equal(result.page.trip_type, "round_trip");
  assert.deepEqual(result.flights.map(f => f.section), ["Top departing flights", "Other departing flights"]);
  assert.deepEqual(result.flights.map(f => [f.price.scope, f.price.basis, f.price.passengers_included]), Array(2).fill(["round_trip_total", "round_trip_total_from_this_departing_flight", 2]));
  assert.deepEqual(result.warnings, ["Google's pricing note mentions 1 adult(s) but the search has 2 traveler(s)."]);
  // Round trips return departing choices only; each reference is for the departing leg of this search.
  const refs = result.flights.map(f => JSON.parse(Buffer.from(f.selection_ref.split(".")[1], "base64url").toString("utf8")));
  assert.deepEqual(refs.map(r => [r.leg, r.outbound, r.search.trip, r.search.legs, r.search.pax]), Array(2).fill(["departing", null, "round_trip", [[departDate, "CVG", "SFO"], [returnDate, "SFO", "CVG"]], [1, 1]]));
});

test("regression: rows behind 'View more flights' are never expanded, whatever the limit, and their existence is disclosed", async () => {
  const extra = card({ dep: "7:00 AM", arr: "9:30 AM", airline: "Alaska", duration: "5 hr 30 min", from: "CVG X", to: "SFO Y", stops: 0, price: "$400", emissions: "300 kg CO2e", comparison: "+5% emissions", segments: [] });
  for (const limit of [1, 2, 150]) {
    const page = resultsPage({ extraCard: extra });
    const result = await harness({ document: page }).execute({ ...oneWay, limit });
    assert.equal(page.moreButton.clicks, 0);
    assert.equal(clicked(page), 0);
    assert.equal(result.status, "ok");
    assert.equal(result.results.rendered_rows, 2);
    assert.equal(result.results.returned_rows, Math.min(limit, 2));
    assert.deepEqual(result.flights.map(f => f.airlines[0]), ["Delta", "United"].slice(0, limit));
    assert.deepEqual(result.results.show_more, { available: true, reason: null });
    assert.equal(result.available_actions.find(a => a.tool === "show_more_flights").enabled, true);
    assert.match(result.warnings.at(-1), /behind 'View more flights'/);
    extra.hidden = true;
  }
});

test("Google's Stops filter sent with the search must show on the page, or the search fails rather than returning an unfiltered list", async () => {
  const page = resultsPage({ stopsChip: "Nonstop" });
  page.cards.b.hidden = true;
  page.querySelector("[aria-live]").text = "1 result returned.";
  const ok = await harness({ document: page }).execute({ ...oneWay, max_stops: 0 });
  assert.equal(ok.status, "ok");
  assert.equal(ok.filters.stops, "nonstop");
  const unfiltered = await harness().execute({ ...oneWay, max_stops: 0 });
  assert.equal(unfiltered.status, "error");
  assert.match(unfiltered.message, /^FILTER_NOT_APPLIED:/);
  const wrongChip = await harness({ document: resultsPage({ stopsChip: "1 stop or fewer" }) }).execute({ ...oneWay, max_stops: 0 });
  assert.match(wrongChip.message, /^FILTER_NOT_APPLIED: Google's Stops filter shows one_or_fewer/);
});

test("the requested tab is confirmed: a search Google opens on Cheapest clicks Best once; Cheapest is clicked when asked", async () => {
  const onCheapest = resultsPage({ selectedView: "cheapest" });
  const best = await harness({ document: onCheapest }).execute(oneWay);
  assert.equal(best.status, "ok");
  assert.equal(best.view_clicked, true);
  assert.equal(best.view.active, "best");
  assert.deepEqual(onCheapest.tabs.map(t => t.clicks), [1, 0]);

  const page = resultsPage();
  const cheapest = await harness({ document: page }).execute({ ...oneWay, view: "cheapest" });
  assert.deepEqual([cheapest.status, cheapest.view.active, cheapest.view_clicked], ["ok", "cheapest", true]);
  assert.deepEqual(page.tabs.map(t => t.clicks), [0, 1]);
});

test("a requested tab Google does not offer, or does not select, is never reported as ok", async () => {
  const none = await harness({ document: resultsPage({ tabs: false }) }).execute({ ...oneWay, view: "cheapest" });
  assert.equal(none.status, "unavailable");
  assert.match(none.message, /does not offer a cheapest tab/);
  const stuck = resultsPage();
  stuck.tabs[1].onclick = () => {};
  const unconfirmed = await harness({ document: stuck, fastClock: true }).execute({ ...oneWay, view: "cheapest" });
  assert.equal(unconfirmed.status, "unconfirmed");
  assert.equal(unconfirmed.view.active, "best");
  assert.equal(stuck.tabs[1].clicks, 1);
});

test("explicit no-results announcements are reported as no_results, with Google's reason", async () => {
  const doc = resultsPage({ live: "No results returned, alternative suggestions found." });
  for (const list of doc.querySelectorAll("ul")) list.hidden = true;
  const h = harness({ document: doc });
  const result = await h.execute({ ...oneWay, max_stops: 0 });
  assert.equal(result.status, "no_results");
  assert.equal(result.message, "No results returned, alternative suggestions found.");
  assert.deepEqual(result.flights, []);
  assert.match(result.results_url, /^https:\/\/www\.google\.com\/travel\/flights\/search\?tfs=/);
});

test("rows under a contradicting 'No results returned' announcement are read once stable, with a warning", async () => {
  const result = await harness({ document: resultsPage({ live: "No results returned." }), fastClock: true }).execute(oneWay);
  assert.equal(result.status, "ok");
  assert.equal(result.flights.length, 2);
  assert.match(result.warnings[0], /contradicts the 2 rows/);
});

test("the consent interstitial is dismissed before reading results", async () => {
  const doc = resultsPage();
  doc.body.append(new El("button", { text: "Accept all" }));
  doc.body.append(new El("button", { text: "Reject all" }));
  const h = harness({ consent: true, document: doc });
  const result = await h.execute(oneWay);
  assert.equal(result.status, "ok");
  assert.equal(doc.body.children.at(-1).clicks, 1);
  assert.equal(doc.body.children.at(-2).clicks, 0);
  assert.equal(doc.documentElement.getAttribute("data-xwebmcp-stale"), "1");
  assert.equal(h.calls.filter(c => c === "wait:html:not([data-xwebmcp-stale]):attached").length, 2);
});

test("a consent page without a recognizable button is an explicit error with unknown controls", async () => {
  const result = await harness({ consent: true }).execute(oneWay);
  assert.equal(result.status, "error");
  assert.match(result.message, /^CONSENT_BLOCKED/);
  assert.equal(result.page, null);
});

test("Google's automated-traffic challenge is reported as blocked", async () => {
  const result = await harness({ sorry: true }).execute(oneWay);
  assert.equal(result.status, "error");
  assert.match(result.message, /^BLOCKED/);
  assert.equal(result.flights.length, 0);
});

test("a page that never announces results or rows times out explicitly", async () => {
  const empty = resultsPage({ live: "" });
  for (const list of empty.querySelectorAll("ul")) list.hidden = true;
  const result = await harness({ document: empty, fastClock: true }).execute(oneWay);
  assert.equal(result.status, "error");
  assert.match(result.message, /^RESULTS_TIMEOUT/);
  assert.equal(result.page.page_type, "departing_results");
  assert.equal(result.page.settled, false);
});

test("an airport code Google drops from the search box is reported as unknown, not as a timeout", async () => {
  const page = resultsPage({ live: "" });
  for (const list of page.querySelectorAll("ul")) list.hidden = true;
  const from = page.body.append(new El("input", { attrs: { "aria-label": "Where from? " } }));
  from.value = "";
  page.body.append(new El("input", { attrs: { "aria-label": "Where to? Los Angeles LAX" } })).value = "Los Angeles";
  const result = await harness({ document: page, fastClock: true }).execute({ ...oneWay, origin: "QQQ" });
  assert.equal(result.status, "error");
  assert.equal(result.message, "UNKNOWN_AIRPORT: Google Flights did not recognize the origin code QQQ.");
});

test("an arrival the day before departure (eastbound date-line crossing) is kept with offset -1", async () => {
  const early = card({ dep: "7:10 AM", arr: "6:30 PM", arrivalDate: plusDays(departDate, -1), airline: "United", duration: "7 hr 20 min", from: "GUM Guam", to: "HNL Honolulu", stops: 0, price: "$900", emissions: "500 kg CO2e", comparison: "Avg emissions",
    segments: [segment({ from: "GUM", fromName: "Guam", dep: "7:10 AM", to: "HNL", toName: "Honolulu", arr: "6:30 PM", travel: "7 hr 20 min", airline: "United", number: "UA 200", aircraft: "Boeing 777" })] });
  const result = await harness({ document: resultsPage({ firstCard: early }) }).execute({ ...oneWay, origin: "GUM", destination: "HNL" });
  assert.equal(result.status, "ok");
  assert.equal(result.flights[0].arrival_day_offset, -1);
  assert.equal(result.flights[0].arrival_date, plusDays(departDate, -1));
});

test("a connection departing after midnight does not move a same-day final arrival to the next day", async () => {
  // SIN 8:35 AM -> HKG 12:35 AM+1, HKG 1:30 AM -> LAX 9:05 PM, back on the departure date.
  const crossing = () => card({ dep: "8:35 AM", arr: "9:05 PM", airline: "Cathay Pacific", duration: "29 hr 30 min", from: "SIN Singapore Changi Airport", to: "LAX Los Angeles International Airport",
    stops: 1, price: "$900", emissions: "900 kg CO2e", comparison: "Avg emissions", tim: `SIN-HKG-CX-710-${departDate.replace(/-/g, "")},HKG-LAX-CX-880-${plusDays(departDate, 1).replace(/-/g, "")}` });
  for (const summaryDated of [true, false]) {
    const first = crossing();
    const summary = first.children[0];
    summary.setAttribute("aria-label", summary.attrs["aria-label"].replace(/ at 9:05 PM\. /, summaryDated ? ` at 9:05 PM on ${longDate(departDate)}. ` : " at 9:05 PM. "));
    const result = await harness({ document: resultsPage({ firstCard: first }) }).execute({ ...oneWay, origin: "SIN", destination: "LAX" });
    assert.equal(result.flights[0].arrival_date, departDate);
    assert.equal(result.flights[0].arrival_day_offset, 0);
  }
});

test("an unreadable row is skipped and disclosed instead of failing the whole search", async () => {
  const broken = card({ dep: "7:10 AM", arr: "9:30 AM", airline: "Spirit", duration: "5 hr", from: "CVG X", to: "SFO Y", stops: 0, price: "$0", priceless: true, emissions: "1 kg CO2e", comparison: "Avg emissions", segments: [], tim: null });
  const result = await harness({ document: resultsPage({ firstCard: broken }) }).execute(oneWay);
  assert.equal(result.status, "ok");
  assert.equal(result.flights.length, 1);
  assert.equal(result.results.rendered_rows, 2);
  assert.deepEqual(result.results.skipped_rows, [{ position: 1, missing: ["itinerary data"] }]);
  assert.equal(result.flights[0].airlines[0], "United");
  assert.match(result.warnings[0], /^Skipped 1 row\(s\) without a readable itinerary: position 1/);
});

test("an announced count above the rendered rows with no 'View more flights' is not_ready, never a complete list", async () => {
  const result = await harness({ document: resultsPage({ live: "3 results returned." }), fastClock: true }).execute(oneWay);
  assert.equal(result.status, "not_ready");
  assert.ok(result.page.unsettled_reasons.includes("announced_count_mismatch"));
  assert.deepEqual(result.flights, []);
});

test("all rows unreadable is an explicit parse error", async () => {
  const page = resultsPage();
  for (const el of page.querySelectorAll("[data-travelimpactmodelwebsiteurl]")) el.attrs["data-travelimpactmodelwebsiteurl"] = "";
  const result = await harness({ document: page }).execute(oneWay);
  assert.equal(result.status, "error");
  assert.match(result.message, /^PARSE_ERROR: Google shows 2 row\(s\)/);
});

test("price.currency comes from Google's label, and mismatches with the request are flagged", async () => {
  const gbp = await harness({ document: resultsPage({ currencyName: "British pounds" }) }).execute({ ...oneWay, currency: "GBP" });
  assert.deepEqual(gbp.flights.map(f => f.price.currency), ["GBP", "GBP"]);
  assert.deepEqual(gbp.warnings, []);
  const fallback = await harness({ document: resultsPage() }).execute({ ...oneWay, currency: "XYZ" });
  assert.deepEqual(fallback.flights.map(f => f.price.currency), ["USD", "USD"]);
  assert.match(fallback.warnings.at(-1), /Google labeled prices as USD, not the requested XYZ/);
  const unknown = await harness({ document: resultsPage({ currencyName: "Martian credits" }) }).execute({ ...oneWay, currency: "MCR" });
  assert.deepEqual(unknown.flights.map(f => f.price.currency), [null, null]);
  assert.match(unknown.warnings.at(-1), /Unrecognized currency label\(s\): Martian credits/);
});

test("non-ASCII currency labels are parsed", async () => {
  const result = await harness({ document: resultsPage({ currencyName: "Icelandic krónur" }) }).execute({ ...oneWay, currency: "ISK" });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.flights.map(f => f.price.currency), ["ISK", "ISK"]);
  assert.equal(result.flights[0].price.currency_label, "Icelandic krónur");
});

test("registry entry matches the file, namespace, and url patterns", () => {
  const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
  const entries = registry.tools.filter(entry => entry.domain === "google.com" && entry.tool === "search_flights");
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry.namespace, "google.com");
  assert.equal(entry.file, "domains/google.com/search_flights.js");
  assert.equal(entry.kind, "cdp");
  assert.deepEqual(entry.url_patterns, Array.from(harness().tools[0].match.url_patterns));
  const sorted = registry.tools.map(t => `${t.domain}\u0000${t.tool}`);
  assert.deepEqual(sorted, [...sorted].sort());
});
