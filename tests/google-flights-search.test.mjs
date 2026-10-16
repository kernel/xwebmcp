import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { El, card as makeCard, segment, plusDays, longDate, validate } from "./google-flights-dom.mjs";

const source = readFileSync(new URL("../domains/google.com/search_flights.js", import.meta.url), "utf8");
const departDate = new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 10);
const returnDate = new Date(Date.now() + 28 * 86400000).toISOString().slice(0, 10);
const oneWay = { origin: "CVG", destination: "SFO", departDate, tripType: "one_way" };
const roundTrip = { ...oneWay, returnDate, tripType: "round_trip" };

const card = options => makeCard({ date: departDate, ...options });

function resultsPage({ live = "2 results returned.", roundTripCards = false, extraCard = null, currencyName = "US dollars", firstCard = null } = {}) {
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
    stops: 1, layoverSummary: "4 hr 42 min layoverLong layover", price: "$1,245", roundTrip: roundTripCards, emissions: "1,416 kg CO2e", comparison: "Avg emissions",
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
  const body = new El("body", { children: [
    liveRegion,
    new El("div", { children: [new El("h3", { text: roundTripCards ? "Top departing flights" : "Top flights" }), new El("ul", { children: [cardA] })] }),
    new El("div", { children: [new El("h3", { text: "Price insights" }), new El("span", { text: "Prices are currently typical" })] }),
    new El("div", { children: [new El("h3", { text: roundTripCards ? "Other departing flights" : "Other flights" }), otherList, moreButton] }),
    new El("ul", { hidden: true, children: [hiddenDuplicate] }),
    new El("p", { text: "Prices include required taxes + fees for 1 adult. Optional charges and bag fees may apply." }),
  ] });
  const documentElement = new El("html", { children: [body] });
  return { documentElement, body, querySelector: s => documentElement.querySelector(s), querySelectorAll: s => documentElement.querySelectorAll(s), cards: { a: cardA, b: cardB }, moreButton };
}

function harness({ startUrl = "https://www.google.com/travel/flights?hl=en", document = resultsPage(), consent = false, sorry = false, matches, timeoutClock = false, onNavigate = () => {} } = {}) {
  const calls = [];
  let url = startUrl;
  let tabId = "target-a";
  const resultsHost = sorry ? "https://www.google.com/sorry/index?continue=x" : null;
  const pageGlobals = () => {
    const location = new URL(url);
    let offset = 0;
    const globals = { document, location, setTimeout, Date, URL, atob, btoa, TextEncoder };
    if (timeoutClock) globals.Date = class extends Date { static now() { offset += 30000; return Date.now() + offset; } };
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
  const execute = async (input, context) => JSON.parse(JSON.stringify(await tools[0].execute(input, context)));
  return { tools, execute, calls, currentUrl: () => url };
}

test("source is a self-contained expression with narrow Google Travel matching and typed schemas", () => {
  const { tools } = harness();
  assert.equal(tools.length, 1);
  const [definition] = tools;
  assert.equal(definition.kind, "cdp");
  assert.deepEqual(Array.from(definition.match.url_patterns), ["https://google.com/travel/*", "https://*.google.com/travel/*"]);
  assert.equal(definition.tool.name, "search_flights");
  assert.equal(definition.tool.inputSchema.type, "object");
  assert.deepEqual(Array.from(definition.tool.inputSchema.required), ["origin", "destination", "departDate", "tripType"]);
  assert.deepEqual(Array.from(definition.tool.inputSchema.properties.tripType.enum), ["one_way", "round_trip"]);
  assert.equal(definition.tool.inputSchema.properties.max_stops.minimum, 0);
  assert.equal(definition.tool.inputSchema.properties.max_stops.maximum, 2);
  assert.equal(definition.tool.inputSchema.properties.passengers.maximum, 9);
  assert.deepEqual(Array.from(definition.tool.inputSchema.properties.cabin.enum), ["economy", "premium_economy", "business", "first"]);
  assert.equal(definition.tool.outputSchema.properties.flights.items.properties.price.properties.amount.type, "number");
  assert.equal(definition.tool.annotations.readOnlyHint, true);
  assert.equal(typeof definition.execute, "function");
});

for (const [name, input, pattern] of [
  ["lowercase airport code", { ...oneWay, origin: "cvg" }, /IATA/],
  ["identical airports", { ...oneWay, destination: "CVG" }, /must differ/],
  ["past departure", { ...oneWay, departDate: "2020-01-01" }, /in the past/],
  ["impossible date", { ...oneWay, departDate: `${departDate.slice(0, 4)}-02-30` }, /real YYYY-MM-DD/],
  ["return before departure", { ...roundTrip, returnDate: plusDays(departDate, -1) }, /on or after departDate/],
  ["round trip without return", { ...oneWay, tripType: "round_trip" }, /requires a real YYYY-MM-DD returnDate/],
  ["one way with return", { ...oneWay, returnDate }, /must omit returnDate/],
  ["too many passengers", { ...oneWay, passengers: 10 }, /1–9 adults/],
  ["unknown cabin", { ...oneWay, cabin: "coach" }, /cabin must be/],
  ["bad currency", { ...oneWay, currency: "us$" }, /currency must be/],
  ["negative stop limit", { ...oneWay, max_stops: -1 }, /max_stops must be/],
  ["unsupported stop limit", { ...oneWay, max_stops: 3 }, /max_stops must be/],
  ["fractional stop limit", { ...oneWay, max_stops: 0.5 }, /max_stops must be/],
  ["string stop limit", { ...oneWay, max_stops: "0" }, /max_stops must be/],
  ["null stop limit", { ...oneWay, max_stops: null }, /max_stops must be/],
]) {
  test(`invalid input (${name}) fails before touching the page`, async () => {
    const h = harness();
    const result = await h.execute(input);
    assert.equal(result.status, "error");
    assert.match(result.message, /^INVALID_INPUT: /);
    assert.match(result.message, pattern);
    assert.equal(result.resultsUrl, "");
    assert.deepEqual(h.calls, []);
    validate(h.tools[0].tool.outputSchema, result);
  });
}

test("deep link encodes the query as Google's tfs protobuf with locale and currency", async () => {
  const h = harness({ document: resultsPage({ live: "No results returned." }) });
  await h.execute({ origin: "CVG", destination: "SFO", departDate, tripType: "one_way", passengers: 2, cabin: "business", currency: "EUR" });
  const target = new URL(h.calls.find(c => c.startsWith("goto:")).slice(5));
  assert.equal(target.origin + target.pathname, "https://www.google.com/travel/flights/search");
  assert.equal(target.searchParams.get("hl"), "en");
  assert.equal(target.searchParams.get("gl"), "US");
  assert.equal(target.searchParams.get("curr"), "EUR");
  const tfs = Buffer.from(target.searchParams.get("tfs"), "base64url");
  // Live-verified layout: one leg (field 3), two adult passengers (field 8), business seat (field 9), one-way trip (field 19).
  const leg = Buffer.concat([Buffer.from([0x12, 10]), Buffer.from(departDate), Buffer.from([0x6a, 7, 0x08, 1, 0x12, 3]), Buffer.from("CVG"), Buffer.from([0x72, 7, 0x08, 1, 0x12, 3]), Buffer.from("SFO")]);
  assert.deepEqual(tfs, Buffer.concat([Buffer.from([0x1a, leg.length]), leg, Buffer.from([0x40, 1, 0x40, 1, 0x48, 3, 0x98, 1, 2])]));
});

for (const max_stops of [0, 1, 2]) {
  for (const input of [oneWay, roundTrip]) {
    test(`${input.tripType} encodes max_stops=${max_stops} on every leg before navigation`, async () => {
      const h = harness({ document: resultsPage({ live: "No results returned." }) });
      await h.execute({ ...input, max_stops });
      const tfs = Buffer.from(new URL(h.calls.find(c => c.startsWith("goto:")).slice(5)).searchParams.get("tfs"), "base64url");
      const leg = (day, from, to) => {
        const payload = Buffer.concat([Buffer.from([0x12, 10]), Buffer.from(day), Buffer.from([0x28, max_stops, 0x6a, 7, 0x08, 1, 0x12, 3]), Buffer.from(from), Buffer.from([0x72, 7, 0x08, 1, 0x12, 3]), Buffer.from(to)]);
        return Buffer.concat([Buffer.from([0x1a, payload.length]), payload]);
      };
      const legs = [leg(departDate, "CVG", "SFO")];
      if (input.tripType === "round_trip") legs.push(leg(returnDate, "SFO", "CVG"));
      assert.deepEqual(tfs, Buffer.concat([...legs, Buffer.from([0x40, 1, 0x48, 1, 0x98, 1, input.tripType === "round_trip" ? 1 : 2])]));
    });
  }
}

test("round trips encode a reversed second leg and the round-trip marker", async () => {
  const h = harness({ document: resultsPage({ live: "No results returned." }) });
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

test("parses best and other sections, segments, layovers, prices and overnight arrivals from the results DOM", async () => {
  const h = harness();
  const result = await h.execute(oneWay);
  validate(h.tools[0].tool.outputSchema, result);
  assert.equal(result.status, "ok");
  assert.equal(result.resultCount, 2);
  assert.equal(result.totalResults, 2);
  assert.equal(result.hasMore, false);
  assert.equal(result.priceInsight, "Prices are currently typical");
  assert.match(result.pricingNote, /^Prices include required taxes \+ fees for 1 adult/);
  assert.deepEqual(result.warnings, []);
  assert.equal(h.currentUrl(), result.resultsUrl);
  const [{ selection_ref: refA, ...a }, b] = result.flights;
  const payload = JSON.parse(Buffer.from(refA.split(".")[1], "base64url").toString("utf8"));
  assert.deepEqual(payload, {
    v: 1, search: { trip: "one_way", legs: [[departDate, "CVG", "SFO"]], pax: [1], cabin: 1 }, leg: "departing", outbound: null,
    itinerary: [["CVG", departDate, "SFO", "DL", "1234"]], departure: `${departDate}T18:08`, arrival: `${departDate}T20:45`, price: [314, "US dollars"],
  });
  assert.notEqual(b.selection_ref, refA);
  assert.deepEqual(a, {
    section: "best", airline: "Delta", airlines: ["Delta"], partnerAirlines: [], operatedBy: null, flightNumbers: ["DL 1234"],
    departureAirport: "CVG", arrivalAirport: "SFO", departureDate: departDate, departureTime: "18:08", arrivalDate: departDate, arrivalTime: "20:45", arrivalDayOffset: 0,
    durationMinutes: 337, stops: 0, layovers: [], emissionsKgCo2e: 245, emissionsVsTypicalPercent: -19,
    price: { amount: 314, currency: "USD", currencyLabel: "US dollars", displayText: "$314", scope: "one_way", passengersIncluded: 1 },
    segments: [{ airline: "Delta", flightNumber: "DL 1234", operatedBy: null, aircraft: "Boeing 737", departureAirport: "CVG", departureTime: "18:08", arrivalAirport: "SFO", arrivalTime: "20:45", durationMinutes: 337 }],
  });
  assert.equal(b.section, "other");
  assert.equal(b.airline, "United");
  assert.deepEqual(b.partnerAirlines, ["Lufthansa", "Air Canada"]);
  assert.equal(b.operatedBy, "SkyWest DBA United Express");
  assert.deepEqual(b.flightNumbers, ["UA 5595", "UA 2106"]);
  assert.equal(b.arrivalDate, plusDays(departDate, 1));
  assert.equal(b.arrivalDayOffset, 1);
  assert.equal(b.arrivalTime, "00:15");
  assert.equal(b.stops, 1);
  assert.deepEqual(b.layovers, [{ airport: "DEN", durationMinutes: 282 }]);
  assert.equal(b.price.amount, 1245);
  assert.equal(b.emissionsKgCo2e, 1416);
  assert.equal(b.emissionsVsTypicalPercent, 0);
  assert.equal(b.segments[0].operatedBy, "SkyWest DBA United Express");
  assert.equal(b.segments[1].arrivalTime, "00:15");
  assert.equal(h.tools[0].tool.outputSchema.required.length, Object.keys(result).length);
});

test("round-trip searches report whole-trip totals and the departing-flight sections", async () => {
  const h = harness({ document: resultsPage({ roundTripCards: true }) });
  const result = await h.execute({ ...roundTrip, passengers: 2 });
  validate(h.tools[0].tool.outputSchema, result);
  assert.equal(result.status, "ok");
  assert.equal(result.tripType, "round_trip");
  assert.deepEqual(result.flights.map(f => f.section), ["best", "other"]);
  assert.deepEqual(result.flights.map(f => f.price.scope), ["round_trip", "round_trip"]);
  assert.deepEqual(result.flights.map(f => f.price.passengersIncluded), [2, 2]);
  assert.deepEqual(result.warnings, ["Google priced the page for 1 adult(s), not the requested 2."]);
  // Round trips return departing choices only; each reference is for the departing leg of this search.
  const refs = result.flights.map(f => JSON.parse(Buffer.from(f.selection_ref.split(".")[1], "base64url").toString("utf8")));
  assert.deepEqual(refs.map(r => [r.leg, r.outbound, r.search.trip, r.search.legs, r.search.pax]), Array(2).fill(["departing", null, "round_trip", [[departDate, "CVG", "SFO"], [returnDate, "SFO", "CVG"]], [1, 1]]));
});

test("expands the collapsed View more flights set only when more results are wanted", async () => {
  const extra = card({ dep: "7:00 AM", arr: "9:30 AM", airline: "Alaska", duration: "5 hr 30 min", from: "CVG X", to: "SFO Y", stops: 0, price: "$400", emissions: "300 kg CO2e", comparison: "+5% emissions", segments: [segment({ from: "CVG", fromName: "X", dep: "7:00 AM", to: "SFO", toName: "Y", arr: "9:30 AM", travel: "5 hr 30 min", airline: "Alaska", number: "AS 100", aircraft: "Boeing 737" })] });
  const page = resultsPage({ extraCard: extra });
  const h = harness({ document: page });
  const result = await h.execute(oneWay);
  assert.equal(page.moreButton.clicks, 1);
  assert.equal(result.resultCount, 3);
  assert.equal(result.totalResults, 3);
  assert.equal(result.hasMore, false);
  assert.deepEqual(result.flights.map(f => f.airline), ["Delta", "United", "Alaska"]);

  const capped = resultsPage({ extraCard: card({ ...{ dep: "7:00 AM", arr: "9:30 AM", airline: "Alaska", duration: "5 hr 30 min", from: "CVG X", to: "SFO Y", stops: 0, price: "$400", emissions: "300 kg CO2e", comparison: "+5% emissions", segments: [] } }) });
  const limited = await harness({ document: capped }).execute({ ...oneWay, maxResults: 1 });
  assert.equal(capped.moreButton.clicks, 0);
  assert.equal(limited.resultCount, 1);
  assert.equal(limited.flights[0].airline, "Delta");
  assert.equal(limited.hasMore, true);
  assert.equal(capped.cards.b.querySelector("button[aria-label^='Flight details']").getAttribute("aria-expanded"), "false");
});

test("the nonstop filter is sent to Google before the default result cap is applied", async () => {
  const page = resultsPage();
  const topList = page.cards.a.parentElement;
  const otherList = page.cards.b.parentElement;
  const nonstop = page.cards.a;
  topList.children = [];
  topList.append(page.cards.b);
  otherList.children = [];
  for (let i = 0; i < 128; i++) {
    otherList.append(card({ dep: "7:00 AM", arr: "9:30 PM", airline: "Example Air", duration: "17 hr 30 min", from: "CVG X", to: "SFO Y", stops: 1, price: "$200", emissions: "300 kg CO2e", comparison: "Avg emissions", segments: [] }));
  }
  otherList.append(nonstop);
  const cards = [...topList.children, ...otherList.children];
  assert.equal(cards.indexOf(nonstop), 129);
  const h = harness({ document: page, onNavigate: url => {
    const tfs = Buffer.from(new URL(url).searchParams.get("tfs"), "base64url");
    assert.ok(tfs.includes(Buffer.from([0x28, 0])));
    // Google applies the encoded stops constraint to its inventory, before the parser sees any cards.
    for (const c of cards) c.hidden = c.querySelector(".EfT7Ae").textContent !== "Nonstop";
    page.querySelector("[aria-live]").text = "1 result returned.";
  } });
  const result = await h.execute({ ...oneWay, max_stops: 0 });
  validate(h.tools[0].tool.outputSchema, result);
  assert.equal(result.status, "ok");
  assert.equal(result.resultCount, 1);
  assert.equal(result.totalResults, 1);
  assert.equal(result.hasMore, false);
  assert.deepEqual(result.flights[0].flightNumbers, ["DL 1234"]);
  assert.deepEqual(result.warnings, []);
  assert.equal(page.cards.b.querySelector("button[aria-label^='Flight details']").clicks, 0);
});

test("a filtered search still reports truncation after the matching itinerary cap", async () => {
  const page = resultsPage();
  page.cards.b.hidden = true;
  const extra = card({ dep: "7:00 AM", arr: "9:30 AM", airline: "Alaska", duration: "5 hr 30 min", from: "CVG X", to: "SFO Y", stops: 0, price: "$400", emissions: "300 kg CO2e", comparison: "+5% emissions", segments: [] });
  page.cards.b.parentElement.append(extra);
  const result = await harness({ document: page }).execute({ ...oneWay, max_stops: 0, maxResults: 1 });
  validate(harness().tools[0].tool.outputSchema, result);
  assert.equal(result.status, "ok");
  assert.equal(result.resultCount, 1);
  assert.equal(result.totalResults, 2);
  assert.equal(result.hasMore, true);
  assert.match(result.warnings[0], /^Partial results:/);
  assert.match(result.warnings[0], /Do not infer an airline or nonstop is unavailable/);
  assert.equal(extra.querySelector("button[aria-label^='Flight details']").clicks, 0);
});

test("an ignored stops constraint is an explicit error rather than an unfiltered success", async () => {
  const h = harness();
  const result = await h.execute({ ...oneWay, max_stops: 0 });
  validate(h.tools[0].tool.outputSchema, result);
  assert.equal(result.status, "error");
  assert.match(result.message, /^FILTER_NOT_APPLIED:/);
  assert.deepEqual(result.flights, []);
});

test("a filtered no-results announcement preserves Google's no-results response", async () => {
  const h = harness({ document: resultsPage({ live: "No results returned, alternative suggestions found." }) });
  const result = await h.execute({ ...oneWay, max_stops: 0 });
  validate(h.tools[0].tool.outputSchema, result);
  assert.equal(result.status, "no_results");
  assert.equal(result.hasMore, false);
  assert.equal(result.totalResults, 0);
});

test("missing segment details leave segments empty with a warning; flight numbers still come from Google's itinerary data", async () => {
  const page = resultsPage();
  page.cards.a.querySelector("button[aria-label^='Flight details']").onclick = null;
  const h = harness({ document: page, timeoutClock: true });
  const result = await h.execute(oneWay);
  validate(h.tools[0].tool.outputSchema, result);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.flights[0].flightNumbers, ["DL 1234"]);
  assert.deepEqual(result.flights[0].segments, []);
  assert.match(result.flights[0].selection_ref, /^gf1\./);
  assert.deepEqual(result.flights[1].flightNumbers, ["UA 5595", "UA 2106"]);
  assert.equal(result.flights[1].segments.length, 2);
  assert.deepEqual(result.warnings, ["1 itinerary detail panel(s) could not be read; their segments are empty."]);
  assert.deepEqual(result.flights[1].layovers, [{ airport: "DEN", durationMinutes: 282 }]);
});

test("explicit no-results announcements are reported, never as an error", async () => {
  const h = harness({ document: resultsPage({ live: "No results returned, alternative suggestions found." }) });
  const result = await h.execute(oneWay);
  validate(h.tools[0].tool.outputSchema, result);
  assert.equal(result.status, "no_results");
  assert.equal(result.totalResults, 0);
  assert.equal(result.resultCount, 0);
  assert.equal(result.message, "No results returned, alternative suggestions found.");
  assert.match(result.resultsUrl, /^https:\/\/www\.google\.com\/travel\/flights\/search\?tfs=/);
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

test("a consent page without a recognizable button is an explicit error", async () => {
  const h = harness({ consent: true });
  const result = await h.execute(oneWay);
  assert.equal(result.status, "error");
  assert.match(result.message, /^CONSENT_BLOCKED/);
});

test("Google's automated-traffic challenge is reported as blocked", async () => {
  const h = harness({ sorry: true });
  const result = await h.execute(oneWay);
  assert.equal(result.status, "error");
  assert.match(result.message, /^BLOCKED/);
  assert.equal(result.flights.length, 0);
});

test("a page that never announces results or cards times out explicitly", async () => {
  const empty = resultsPage({ live: "" });
  for (const list of empty.querySelectorAll("ul")) list.hidden = true;
  const h = harness({ document: empty, timeoutClock: true });
  const result = await h.execute(oneWay);
  assert.equal(result.status, "error");
  assert.match(result.message, /^RESULTS_TIMEOUT/);
});

test("an arrival the day before departure (eastbound date-line crossing) is kept with offset -1", async () => {
  const early = card({ dep: "7:10 AM", arr: "6:30 PM", arrivalDate: plusDays(departDate, -1), airline: "United", duration: "7 hr 20 min", from: "GUM Guam", to: "HNL Honolulu", stops: 0, price: "$900", emissions: "500 kg CO2e", comparison: "Avg emissions",
    segments: [segment({ from: "GUM", fromName: "Guam", dep: "7:10 AM", to: "HNL", toName: "Honolulu", arr: "6:30 PM", travel: "7 hr 20 min", airline: "United", number: "UA 200", aircraft: "Boeing 777" })] });
  const h = harness({ document: resultsPage({ firstCard: early }) });
  const result = await h.execute({ ...oneWay, origin: "GUM", destination: "HNL" });
  validate(h.tools[0].tool.outputSchema, result);
  assert.equal(result.status, "ok");
  assert.equal(result.flights[0].arrivalDayOffset, -1);
  assert.equal(result.flights[0].arrivalDate, plusDays(departDate, -1));
});

test("an airport code Google drops from the search box is reported as unknown, not as a timeout", async () => {
  const page = resultsPage({ live: "" });
  for (const list of page.querySelectorAll("ul")) list.hidden = true;
  const from = page.body.append(new El("input", { attrs: { "aria-label": "Where from? " } }));
  from.value = "";
  page.body.append(new El("input", { attrs: { "aria-label": "Where to? Los Angeles LAX" } })).value = "Los Angeles";
  const h = harness({ document: page, timeoutClock: true });
  const result = await h.execute({ ...oneWay, origin: "QQQ" });
  assert.equal(result.status, "error");
  assert.equal(result.message, "UNKNOWN_AIRPORT: Google Flights did not recognize the origin code QQQ.");
});

test("a connection departing after midnight does not move a same-day final arrival to the next day", async () => {
  // SIN 8:35 AM -> HKG 12:35 AM+1 (Google prints "+1" in the expanded segment), HKG 1:30 AM -> LAX 9:05 PM, back on the departure date.
  const crossing = card({ dep: "8:35 AM", arr: "9:05 PM", airline: "Cathay Pacific", duration: "29 hr 30 min", from: "SIN Singapore Changi Airport", to: "LAX Los Angeles International Airport",
    stops: 1, price: "$900", emissions: "900 kg CO2e", comparison: "Avg emissions",
    segments: [
      segment({ from: "SIN", fromName: "Singapore Changi Airport", dep: "8:35 AM", to: "HKG", toName: "Hong Kong International Airport", arr: "12:35 AM", plus: "+1", travel: "16 hr", airline: "Cathay Pacific", number: "CX 710", aircraft: "Airbus A350", layover: "55 min layoverHong Kong (HKG)" }),
      segment({ from: "HKG", fromName: "Hong Kong International Airport", dep: "1:30 AM", depPlus: "+1", to: "LAX", toName: "Los Angeles International Airport", arr: "9:05 PM", travel: "12 hr 35 min", airline: "Cathay Pacific", number: "CX 880", aircraft: "Boeing 777" }),
    ] });
  const run = async summaryDated => {
    const page = resultsPage({ firstCard: crossing });
    const summary = crossing.children[0];
    const label = summary.attrs["aria-label"].replace(/ at 9:05 PM\. /, summaryDated ? ` at 9:05 PM on ${longDate(departDate)}. ` : " at 9:05 PM. ");
    summary.setAttribute("aria-label", label);
    const h = harness({ document: page });
    const result = await h.execute({ ...oneWay, origin: "SIN", destination: "LAX" });
    validate(h.tools[0].tool.outputSchema, result);
    return result.flights[0];
  };
  for (const summaryDated of [true, false]) {
    const flight = await run(summaryDated);
    assert.equal(flight.arrivalDate, departDate);
    assert.equal(flight.arrivalDayOffset, 0);
  }
});

test("an unreadable card is skipped with a warning instead of failing the whole search", async () => {
  const broken = card({ dep: "7:10 AM", arr: "9:30 AM", airline: "Spirit", duration: "5 hr", from: "CVG X", to: "SFO Y", stops: 0, price: "$0", priceless: true, emissions: "1 kg CO2e", comparison: "Avg emissions", segments: [] });
  const h = harness({ document: resultsPage({ firstCard: broken }), timeoutClock: true });
  const result = await h.execute(oneWay);
  validate(h.tools[0].tool.outputSchema, result);
  assert.equal(result.status, "ok");
  assert.equal(result.resultCount, 1);
  assert.equal(result.totalResults, 2);
  assert.equal(result.flights[0].airline, "United");
  assert.match(result.warnings[0], /^Skipped 1 unreadable itinerary card\(s\): itinerary 1/);
  assert.match(result.warnings[1], /^Partial results:/);
});

test("an announced count that disagrees with the cards read is reported as possibly incomplete", async () => {
  const h = harness({ document: resultsPage({ live: "3 results returned." }), timeoutClock: true });
  const result = await h.execute(oneWay);
  validate(h.tools[0].tool.outputSchema, result);
  assert.equal(result.status, "ok");
  assert.equal(result.resultCount, 2);
  assert.equal(result.hasMore, true);
  assert.match(result.warnings[0], /^Google announced 3 results but 2 were on the page when read/);
});

test("all cards unreadable is an explicit parse error", async () => {
  const page = resultsPage();
  for (const span of page.querySelectorAll("span[aria-label$='dollars']")) span.attrs["aria-label"] = "";
  const result = await harness({ document: page }).execute(oneWay);
  assert.equal(result.status, "error");
  assert.match(result.message, /^PARSE_ERROR: Google announced results but no itinerary card was readable/);
});

test("price.currency comes from Google's label, and mismatches with the request are flagged", async () => {
  const gbp = await harness({ document: resultsPage({ currencyName: "British pounds" }) }).execute({ ...oneWay, currency: "GBP" });
  assert.deepEqual(gbp.flights.map(f => f.price.currency), ["GBP", "GBP"]);
  assert.deepEqual(gbp.warnings, []);

  const fallback = await harness({ document: resultsPage() }).execute({ ...oneWay, currency: "XYZ" });
  assert.deepEqual(fallback.flights.map(f => f.price.currency), ["USD", "USD"]);
  assert.deepEqual(fallback.warnings, ["Google labeled prices as US dollars (USD), not the requested XYZ; price.currency reports USD."]);

  const unknown = await harness({ document: resultsPage({ currencyName: "Martian credits" }) }).execute({ ...oneWay, currency: "MCR" });
  assert.deepEqual(unknown.flights.map(f => f.price.currency), ["MCR", "MCR"]);
  assert.match(unknown.warnings[0], /not a recognized currency name; price.currency repeats the requested MCR unverified/);
});

test("non-ASCII currency labels are parsed", async () => {
  const h = harness({ document: resultsPage({ currencyName: "Icelandic krónur" }) });
  const result = await h.execute({ ...oneWay, currency: "ISK" });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.flights.map(f => f.price.currency), ["ISK", "ISK"]);
  assert.equal(result.flights[0].price.currencyLabel, "Icelandic krónur");
  assert.deepEqual(result.warnings, []);
});

test("a card that never opens its details is not waited on for the whole budget", async () => {
  const page = resultsPage();
  page.cards.a.querySelector("button[aria-label^='Flight details']").onclick = null;
  const started = Date.now();
  const result = await harness({ document: page, timeoutClock: true }).execute(oneWay);
  assert.ok(Date.now() - started < 5000);
  assert.deepEqual(result.flights[0].segments, []);
  assert.deepEqual(result.warnings, ["1 itinerary detail panel(s) could not be read; their segments are empty."]);
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
