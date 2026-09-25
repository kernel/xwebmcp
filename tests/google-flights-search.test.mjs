import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../domains/google.com/search_flights.js", import.meta.url), "utf8");
const departDate = new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 10);
const returnDate = new Date(Date.now() + 28 * 86400000).toISOString().slice(0, 10);
const oneWay = { origin: "CVG", destination: "SFO", departDate, tripType: "one_way" };
const roundTrip = { ...oneWay, returnDate, tripType: "round_trip" };
const plusDays = (iso, days) => new Date(Date.parse(iso) + days * 86400000).toISOString().slice(0, 10);
const longDate = iso => new Date(iso).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });

// Minimal DOM: only what the tool's page functions use.
class El {
  constructor(tag, { cls = "", attrs = {}, text = "", hidden = false, children = [] } = {}) {
    this.tagName = tag.toUpperCase();
    this.className = cls;
    this.attrs = { ...attrs };
    this.text = text;
    this.hidden = hidden;
    this.parentElement = null;
    this.children = [];
    this.clicks = 0;
    for (const child of children) this.append(child);
  }
  append(child) { child.parentElement = this; this.children.push(child); return child; }
  get textContent() { return this.text + this.children.map(c => c.textContent).join(""); }
  get innerText() { return this.text + this.children.map(c => c.innerText).join("\n"); }
  get classes() { return this.className.split(" ").filter(Boolean); }
  isVisible() { return !this.hidden && (!this.parentElement || this.parentElement.isVisible()); }
  getClientRects() { return this.isVisible() ? [{}] : []; }
  getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  click() { this.clicks++; this.onclick?.(); }
  descendants() { return this.children.flatMap(c => [c, ...c.descendants()]); }
  matches(compound) {
    const tag = compound.match(/^[a-z0-9]+/i)?.[0];
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    for (const [, cls] of compound.matchAll(/\.([\w-]+)/g)) if (!this.classes.includes(cls)) return false;
    for (const [, name, op, value] of compound.matchAll(/\[([\w-]+)(?:([\^$]?=)["']([^"']*)["'])?\]/g)) {
      const actual = this.getAttribute(name);
      if (actual === null) return false;
      if (op === "=" && actual !== value) return false;
      if (op === "^=" && !actual.startsWith(value)) return false;
      if (op === "$=" && !actual.endsWith(value)) return false;
    }
    return true;
  }
  querySelectorAll(selector) {
    const out = [];
    for (const part of selector.split(",").map(s => s.trim())) {
      const steps = part.replace(/^:scope\s*/, "").split(/\s+(?=[^\]]*(?:\[|$))/).filter(Boolean);
      let candidates = [this];
      let childOnly = false;
      for (const step of steps) {
        if (step === ">") { childOnly = true; continue; }
        const next = [];
        for (const node of candidates) for (const el of childOnly ? node.children : node.descendants()) if (el.matches(step) && !next.includes(el)) next.push(el);
        candidates = next;
        childOnly = false;
      }
      for (const el of candidates) if (!out.includes(el)) out.push(el);
    }
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

function segment({ from, fromName, dep, to, toName, arr, plus = "", travel, airline, number, aircraft, cabin = "Economy", operator = null, layover = null }) {
  const block = new El("div", { cls: "c257Jb", children: [
    new El("span", { cls: "b0EVyb", text: dep }),
    new El("span", { cls: "ZHa2lc", text: `${fromName} (${from})` }),
    new El("span", { cls: "P102Lb", text: `Travel time: ${travel}` }),
    new El("span", { cls: "OJg28c", text: arr, children: plus ? [new El("span", { cls: "bOzv6", text: plus })] : [] }),
    new El("span", { cls: "FY5t7d", text: `${toName} (${to})` }),
    new El("span", { cls: "Xsgmwe", text: airline }),
    new El("span", { cls: "Xsgmwe", text: number }),
    new El("span", { cls: "Xsgmwe", text: cabin }),
    new El("span", { cls: "Xsgmwe", text: aircraft }),
    new El("span", { cls: "Xsgmwe", text: number }),
    new El("span", { cls: "h6GTp", text: "Emissions estimate: 100 kg CO2e" }),
  ] });
  if (operator) block.append(new El("span", { cls: "CoZk4", text: `Plane and crew by ${operator}` }));
  if (layover) block.append(new El("span", { cls: "tvtJdb", text: layover }));
  return block;
}

function card({ dep, arr, plus = "", arrivalDate, airline, partners = null, operatedBy = null, duration, from, to, stops, layoverSummary = "", price, currencyName = "US dollars", roundTrip = false, emissions, comparison, segments, hidden = false }) {
  const arrivalDay = arrivalDate ? ` on  ${longDate(arrivalDate)}` : "";
  const summary = `From ${price.replace(/[^\d]/g, "")} ${currencyName}${roundTrip ? " round trip total" : ""}. ${stops ? `${stops} stop` : "Nonstop"} flight with ${airline}. ${operatedBy ? `Operated by ${operatedBy}. ` : ""}Leaves ${from} at ${dep} and arrives at ${to} at ${arr}${arrivalDay}. Total duration ${duration}.  Select flight`;
  const carrierRow = new El("div", { cls: "sSHqwe", children: [new El("span", { text: airline }), new El("span", { cls: "qeoz6e", text: "" })] });
  if (operatedBy) carrierRow.append(new El("span", { text: `Operated by ${operatedBy}` }));
  if (partners) carrierRow.append(new El("span", { text: partners }));
  const details = new El("button", { attrs: { "aria-label": `Flight details. Leaves ${from} at ${dep}.`, "aria-expanded": "false" } });
  const li = new El("li", { cls: "pIav2d", hidden, children: [
    new El("div", { attrs: { "aria-label": summary }, children: [
      new El("div", { cls: "mv1WYe", children: [
        new El("span", { attrs: { "aria-label": `Departure time: ${dep}.` }, text: dep }),
        new El("span", { attrs: { "aria-label": `Arrival time: ${arr}${arrivalDay}.` }, text: arr, children: plus ? [new El("span", { cls: "bOzv6", text: plus })] : [] }),
      ] }),
      carrierRow,
      new El("div", { cls: "gvkrdb", attrs: { "aria-label": `Total duration ${duration}.` }, text: duration }),
      new El("div", { cls: "QylvBf", text: from.slice(0, 3), children: [new El("span", { cls: "eoY5cb", text: from.slice(4) })] }),
      new El("div", { cls: "QylvBf", text: to.slice(0, 3), children: [new El("span", { cls: "eoY5cb", text: to.slice(4) })] }),
      new El("div", { cls: "EfT7Ae", text: stops ? `${stops} stop${stops > 1 ? "s" : ""}${layoverSummary}` : "Nonstop" }),
      new El("div", { cls: "AdWm1c", text: emissions }),
      new El("div", { cls: "rRrlfc", text: comparison }),
      new El("div", { cls: "YMlIz", children: [new El("span", { attrs: { "aria-label": `${price.replace(/[^\d]/g, "")} ${currencyName}` }, text: price })] }),
      ...(roundTrip ? [new El("span", { text: "round trip" })] : []),
      details,
    ] }),
  ] });
  details.onclick = () => {
    details.setAttribute("aria-expanded", "true");
    for (const block of segments) li.append(block);
  };
  return li;
}

function resultsPage({ live = "2 results returned.", roundTripCards = false, extraCard = null } = {}) {
  const cardA = card({
    dep: "6:08 PM", arr: "8:45 PM", airline: "Delta", duration: "5 hr 37 min",
    from: "CVG Cincinnati/Northern Kentucky International Airport", to: "SFO San Francisco International Airport",
    stops: 0, price: "$314", roundTrip: roundTripCards, emissions: "245 kg CO2e", comparison: "-19% emissions",
    segments: [segment({ from: "CVG", fromName: "Cincinnati/Northern Kentucky International Airport", dep: "6:08 PM", to: "SFO", toName: "San Francisco International Airport", arr: "8:45 PM", travel: "5 hr 37 min", airline: "Delta", number: "DL 1234", aircraft: "Boeing 737" })],
  });
  const cardB = card({
    dep: "4:32 PM", arr: "12:15 AM", plus: "+1", arrivalDate: plusDays(departDate, 1), airline: "United", operatedBy: "SkyWest DBA United Express",
    partners: "Lufthansa, Air Canada", duration: "10 hr 43 min",
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

function harness({ startUrl = "https://www.google.com/travel/flights?hl=en", document = resultsPage(), consent = false, sorry = false, matches, timeoutClock = false } = {}) {
  const calls = [];
  let url = startUrl;
  let tabId = "target-a";
  const resultsHost = sorry ? "https://www.google.com/sorry/index?continue=x" : null;
  const pageGlobals = () => {
    const location = new URL(url);
    let offset = 0;
    const globals = { document, location, setTimeout, Date };
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
    },
    waitForElement: async (selector, options) => { calls.push(`wait:${selector}:${options.state}`); return true; },
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

// Small JSON Schema walker so fixture results are checked against the tool's own outputSchema.
function validate(schema, value, path = "$") {
  const type = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
  if (type.length) assert.ok(type.includes(actual) || (actual === "integer" && type.includes("number")), `${path}: type ${actual} not in ${type}`);
  if (schema.enum) assert.ok(schema.enum.includes(value), `${path}: ${JSON.stringify(value)} not in enum`);
  if ("const" in schema) assert.equal(value, schema.const, `${path}: const`);
  if (schema.pattern && typeof value === "string") assert.match(value, new RegExp(schema.pattern), `${path}: pattern`);
  if (schema.minLength !== undefined && typeof value === "string") assert.ok(value.length >= schema.minLength, `${path}: minLength`);
  if (schema.minimum !== undefined && typeof value === "number") assert.ok(value >= schema.minimum, `${path}: minimum`);
  if (schema.maximum !== undefined && typeof value === "number") assert.ok(value <= schema.maximum, `${path}: maximum`);
  if (schema.exclusiveMinimum !== undefined && typeof value === "number") assert.ok(value > schema.exclusiveMinimum, `${path}: exclusiveMinimum`);
  if (actual === "array") {
    if (schema.minItems !== undefined) assert.ok(value.length >= schema.minItems, `${path}: minItems`);
    if (schema.items) value.forEach((item, i) => validate(schema.items, item, `${path}[${i}]`));
  }
  if (actual === "object") {
    for (const key of schema.required ?? []) assert.ok(key in value, `${path}: missing ${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) validate(schema.properties[key], item, `${path}.${key}`);
      else if (schema.additionalProperties === false) assert.fail(`${path}: unexpected property ${key}`);
    }
  }
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
  const [a, b] = result.flights;
  assert.deepEqual(a, {
    section: "best", airline: "Delta", airlines: ["Delta"], partnerAirlines: [], operatedBy: null, flightNumbers: ["DL 1234"],
    departureAirport: "CVG", arrivalAirport: "SFO", departureDate: departDate, departureTime: "18:08", arrivalDate: departDate, arrivalTime: "20:45", arrivalDayOffset: 0,
    durationMinutes: 337, stops: 0, layovers: [], emissionsKgCo2e: 245, emissionsVsTypicalPercent: -19,
    price: { amount: 314, currency: "USD", displayText: "$314", scope: "one_way", passengersIncluded: 1 },
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

test("missing segment details leave flightNumbers empty with a warning instead of failing", async () => {
  const page = resultsPage();
  page.cards.a.querySelector("button[aria-label^='Flight details']").onclick = null;
  const h = harness({ document: page, timeoutClock: true });
  const result = await h.execute(oneWay);
  validate(h.tools[0].tool.outputSchema, result);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.flights[0].flightNumbers, []);
  assert.deepEqual(result.flights[0].segments, []);
  assert.deepEqual(result.flights[1].flightNumbers, ["UA 5595", "UA 2106"]);
  assert.match(result.warnings[0], /1 itinerary detail panel\(s\) did not expand/);
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
  const h = harness({ consent: true, document: Object.assign(resultsPage(), { consentButtons: true }) });
  const page = h.tools; // keep reference for clarity
  const doc = resultsPage();
  doc.body.append(new El("button", { text: "Accept all" }));
  doc.body.append(new El("button", { text: "Reject all" }));
  const consentHarness = harness({ consent: true, document: doc });
  const result = await consentHarness.execute(oneWay);
  assert.equal(result.status, "ok");
  assert.equal(doc.body.children.at(-1).clicks, 1);
  assert.equal(doc.body.children.at(-2).clicks, 0);
  assert.equal(consentHarness.calls.filter(c => c === "wait:html:not([data-xwebmcp-stale]):attached").length, 2);
  assert.ok(page && h);
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
