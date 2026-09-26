import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

// Harness for the ticketmaster.com event tools. Every page, API and accessibility-tree interaction is stubbed;
// nothing here contacts the live site. Events, venues, prices and keys below are fabricated.
const NAMES = ["search_events", "get_event", "get_ticket_offers"];
const sources = Object.fromEntries(NAMES.map(name => [name, readFileSync(new URL(`../domains/ticketmaster.com/${name}.js`, import.meta.url), "utf8")]));
const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
const plain = value => JSON.parse(JSON.stringify(value));
const HOME = "https://www.ticketmaster.com/";
const FAKE_KEY = "fabricatedkey000";
const FAKE_SECRET = "fabricatedsecret000";

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
    if (schema.format === "uri" && !URL.canParse(value)) return false;
  }
  if (typeof value === "number") {
    if (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) return false;
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) return false;
  }
  return true;
}

// --- fabricated site data ---------------------------------------------------------------------------

const venue = (name, city, state, latitude, longitude) => ({ name, city, state, countryCode: "US", addressLineOne: "1 Example Way", code: "90000", latitude, longitude });
const searchEvent = (id, title, startDate, v, extra = {}) => ({
  title, id, url: `https://www.ticketmaster.com/${title.toLowerCase().replace(/[^a-z]+/g, "-")}/event/${id}`,
  dates: { dateDisplay: "showDateTime", startDate }, timeZone: "America/Los_Angeles", venue: v,
  soldOut: false, limitedAvailability: false, cancelled: false, postponed: false, rescheduled: false, virtual: false, artists: [{ name: title + " Performer" }], ...extra
});
const NEAR = venue("Example Hall", "Los Angeles", "CA", 34.06, -118.25);
const FAR = venue("Far Arena", "New York", "NY", 40.75, -73.99);
const CITY_MATCHES = [
  { name: "Springfield, IL", latitude: 39.8, longitude: -89.65, marketName: "Central Illinois" },
  { name: "Los Angeles, CA", latitude: 34.0551, longitude: -118.257, marketName: "Greater Los Angeles Area" },
  { name: "Los Angeles, TX", latitude: 26.49, longitude: -97.78, marketName: "South Texas" }
];

const eventInfo = (id, extra = {}) => ({
  eventId: id, name: "Fabricated Comedy Night", sourceName: "HOST", canonicalUrl: `/fabricated-comedy-night/event/${id}`, timeZone: "America/Los_Angeles",
  dates: { dateDisplay: "showDateTime", startDate: "2026-10-04T03:30:00Z", onsaleDate: "2026-05-01T17:00:00Z", offsaleDate: "2026-10-04T03:30:00Z", presaleDates: [{ title: "Fan Presale", startDate: "2026-04-28T17:00:00Z", endDate: "2026-04-30T17:00:00Z" }] },
  doorsTimes: { dateTime: "2026-10-04T02:30:00Z" }, eventChangeStatus: "none",
  venue: { name: "Example Hall", streetAddress: "1 Example Way", city: "Los Angeles", state: "CA", zip: "90000", country: "US", latitude: 34.06, longitude: -118.25 },
  classifications: [{ primary: true, segment: { name: "Arts & Theatre" }, genre: { name: "Comedy" }, subGenre: { name: "Undefined" } }],
  artists: [{ name: "Example Comic" }], ticketLimitText: "There is an 8 ticket limit.", restrictSingleSeats: false, ageRestrictions: { ageRuleDescription: "18 & Over" },
  isResaleEnabled: true, currencyCode: "USD", edpPopup: { title: "By proceeding you agree to the ticket terms." }, webInfoNoHtml: "Doors open one hour early.", ...extra
});

const offer = (offerId, inventoryType, totalPrice, extra = {}) => ({ offerId, inventoryType, name: inventoryType === "primary" ? "Standard Ticket" : undefined, currency: "USD", listPrice: totalPrice - 5, faceValue: totalPrice - 5, totalPrice, charges: [{ amount: 5 }], sellableQuantities: [2, 4], ...extra });
const quickpicks = (picks = null) => ({
  total: picks ? picks.length : 3,
  picks: picks ?? [
    { section: "101", row: "A", quality: 0.95, descriptionId: "D1", area: "1", offerGroups: [{ offers: ["O1"], seats: ["1", "2", "3", "4"] }] },
    { section: "205", row: "K", quality: 0.4, descriptionId: "D2", area: "2", offerGroups: [{ offers: ["O2", "O3"], seats: ["7", "8"] }] },
    { section: "301", row: "Z", quality: 0.2, area: "2", offerGroups: [{ offers: ["O4"], seats: [] }] }
  ],
  _embedded: {
    offer: [offer("O1", "resale", 250.5), offer("O2", "primary", 80.25), offer("O3", "primary", 60.1), offer("O4", "primary", 40)],
    area: [{ areaId: "1", description: "Lower Level" }, { areaId: "2", name: "UPPER" }],
    description: [{ descriptionId: "D1", descriptions: ["Lower Level", "Center"] }, { descriptionId: "D2", descriptions: [] }]
  }
});
const nextData = (page, withKey = true) => ({
  page, props: { pageProps: page === "/naevent/[eventId]" ? { edpData: { ...(withKey ? { ismdsApiKey: FAKE_KEY, ismdsApiSecret: FAKE_SECRET } : {}), ismdsPricingURL: "https://offeradapter.ticketmaster.com/api/ismds", context: { resaleChannelId: "fabricated.channel" } } } : {} }
});

// --- harness ------------------------------------------------------------------------------------------

function harness(name, o = {}) {
  let url = o.url ?? HOME;
  const calls = { navigations: [], api: [], xhr: [], clicks: [], keys: [], js: 0 };
  let page = o.page ?? null;
  const pageFor = u => (typeof o.pageFor === "function" ? o.pageFor(u, calls) : null) ?? page;
  const panel = o.panel ? { quantity: 2, open: false, sortOpen: false, sort: "Lowest Price", ...plain(o.panel) } : null;
  const apiRoute = path => {
    calls.api.push(path);
    if (o.api) { const forced = o.api(path); if (forced) return forced; }
    if (path.startsWith("/api/discovery/location/city")) return { status: 200, body: CITY_MATCHES };
    if (path.startsWith("/api/discovery/location/code")) return { status: 200, body: [{ name: "90000, Los Angeles, CA", latitude: 34.05, longitude: -118.25, marketName: "Greater Los Angeles Area" }] };
    if (path.startsWith("/api/search/events")) return { status: 200, body: { total: 3, events: [] } };
    if (path.startsWith("/api/eventinfo/")) return { status: 200, body: eventInfo(decodeURIComponent(path.split("/").pop())) };
    return { status: 404, body: {} };
  };
  class FakeXHR {
    open(method, target) { this.method = method; this.target = target; }
    setRequestHeader(k, v) { (this.headers ??= {})[k] = v; }
    send() {
      calls.xhr.push({ url: this.target, withCredentials: this.withCredentials, headers: this.headers });
      const r = o.xhr ? o.xhr(this.target) : { status: 200, body: quickpicks() };
      this.status = r.status;
      this.responseText = r.body === undefined ? "" : typeof r.body === "string" ? r.body : JSON.stringify(r.body);
      queueMicrotask(() => (r.status === 0 ? this.onerror() : this.onload()));
    }
  }
  const pageContext = () => {
    const p = pageFor(url) || {};
    return {
      JSON, URL, URLSearchParams, Promise, queueMicrotask, XMLHttpRequest: FakeXHR,
      crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
      document: {
        title: p.title ?? "Ticketmaster", body: { innerText: p.text ?? "" },
        getElementById: id => id === "__NEXT_DATA__" && p.next ? { textContent: JSON.stringify(p.next) } : null
      },
      Intl, Math, Date, Number, Object, Array, String, RegExp, Map, Set, Infinity, NaN, isFinite,
      fetch: async (path, init) => {
        assert.equal(init.credentials, "include");
        assert.equal(init.headers["x-tmplatform"], "global");
        const r = apiRoute(path);
        return { status: r.status, text: async () => (r.body === undefined ? "<html>" : JSON.stringify(r.body)) };
      }
    };
  };
  const snapshot = () => {
    const nodes = [];
    if (!panel) return { nodes: [{ role: "heading", name: "Something else", backendNodeId: 1 }] };
    if (panel.loading) return { nodes };
    const listings = (panel.listings[panel.quantity] ?? []);
    nodes.push({ role: "StaticText", name: listings.length + (listings.length === 1 ? " Result" : " Results"), backendNodeId: 10 });
    nodes.push({ role: "button", name: panel.sort, backendNodeId: 11 });
    if (panel.qtyButton !== false) nodes.push({ role: "button", name: `Open quantity filters, current quantity: ${panel.quantity} Ticket${panel.quantity > 1 ? "s" : ""}`, backendNodeId: 12 });
    if (panel.open) for (const q of panel.quantities ?? [1, 2, 3, 4, 5, 6, 7, 8]) nodes.push({ role: "radio", name: `Set quantity to: ${q} Ticket${q > 1 ? "s" : ""}`, backendNodeId: 100 + q });
    if (panel.sortOpen) nodes.push({ role: "button", name: "Low to high Ordered by price lowest to highest", backendNodeId: 21 }, { role: "button", name: "High to low Ordered by price highest to lowest", backendNodeId: 22 });
    if (!listings.length) nodes.push({ role: "StaticText", name: "No seats match your filters", backendNodeId: 13 });
    listings.forEach((l, i) => {
      nodes.push({ role: "menuitem", name: l, backendNodeId: 200 + i });
      nodes.push({ role: "button", name: l, backendNodeId: 300 + i });
      nodes.push({ role: "StaticText", name: l.replace(/ \$.*/, ""), backendNodeId: 400 + i });
    });
    return { nodes };
  };
  const byId = id => snapshot().nodes.find(n => n.backendNodeId === id);
  const context = {
    URL, URLSearchParams, JSON,
    pageInfo: async () => ({ url }),
    gotoUrl: async next => { calls.navigations.push(next); url = o.redirect ? o.redirect(next) : next; },
    waitForLoad: async () => o.loads !== false,
    waitMs: async () => {},
    js: async (fn, options) => {
      calls.js++;
      const run = runInNewContext("(" + fn.toString() + ")", pageContext());
      return plain(await run(options?.arg));
    },
    accessibilitySnapshot: async () => snapshot(),
    click: async ({ backendNodeId }) => {
      const node = byId(backendNodeId);
      assert.ok(node, "clicked a node that is not on the page: " + backendNodeId);
      calls.clicks.push(node.name);
      assert.ok(!/^Select /.test(node.name), "must never click a listing");
      if (backendNodeId === 12) panel.open = true;
      else if (backendNodeId > 100 && backendNodeId <= 108) { panel.quantity = backendNodeId - 100; if (!panel.stayOpen) panel.open = false; }
      else if (backendNodeId === 11) panel.sortOpen = true;
      else if (backendNodeId === 21) { panel.sort = "Lowest Price"; panel.sortOpen = false; }
    },
    pressKey: async key => { calls.keys.push(key); if (key === "Escape" && panel) { panel.open = false; panel.sortOpen = false; } }
  };
  // Page tools run inside the document, so their globals are the page's; CDP tools get the runtime helpers.
  const kind = /^\[\{\s*kind: "page"/.test(sources[name]) ? "page" : "cdp";
  const [definition] = runInNewContext(`(${sources[name]})`, kind === "page" ? { ...pageContext(), window: { location: new URL(url) } } : context);
  return {
    definition, calls, panel,
    run: async input => {
      const result = plain(await definition.execute(input));
      assert.ok(conforms(definition.tool.outputSchema, result), `${name} output violates its schema: ${JSON.stringify(result)}`);
      assert.ok(!JSON.stringify(result).includes(FAKE_KEY) && !JSON.stringify(result).includes(FAKE_SECRET), "the page's service key must not leave the page");
      return result;
    }
  };
}

// --- structure ----------------------------------------------------------------------------------------

for (const name of NAMES) {
  test(`${name}: single-expression CDP tool with typed schemas and a registry entry`, () => {
    assert.equal(sources[name].trimEnd().endsWith(";"), false);
    assert.equal(/\b(Buffer|require|process)\b/.test(sources[name]), false, "tool source must not depend on Node globals");
    assert.equal(/checkout\.ticketmaster|\/checkout|api\/reserve|addToCart|\/cart/i.test(sources[name]), false, "tool source must not reference checkout, reserve or cart endpoints");
    const { definition } = harness(name);
    assert.equal(definition.tool.name, name);
    assert.equal(definition.kind, name === "get_ticket_offers" ? "cdp" : "page");
    assert.deepEqual(plain(definition.match.url_patterns), ["https://www.ticketmaster.com/*"]);
    if (definition.kind === "page") assert.equal(/\b(js|gotoUrl|pageInfo|waitForLoad|accessibilitySnapshot|click|pressKey)\(/.test(definition.execute.toString()), false, "page tools cannot use runtime helpers");
    assert.equal(definition.tool.inputSchema.type, "object");
    assert.equal(definition.tool.inputSchema.additionalProperties, false);
    assert.equal(definition.tool.outputSchema.type, "object");
    assert.equal(definition.tool.annotations.readOnlyHint, true);
    assert.equal(definition.tool.annotations.destructiveHint, false);
    const entry = registry.tools.find(t => t.domain === "ticketmaster.com" && t.tool === name);
    assert.ok(entry, "registry entry missing");
    assert.equal(entry.file, `domains/ticketmaster.com/${name}.js`);
    assert.deepEqual(entry.url_patterns, plain(definition.match.url_patterns));
  });
}

test("registry lists every ticketmaster.com tool exactly once", () => {
  assert.deepEqual(registry.tools.filter(t => t.domain === "ticketmaster.com").map(t => t.tool).sort(), [...NAMES].sort());
});

// --- input validation happens before any page access -----------------------------------------------

const invalidInputs = {
  search_events: [undefined, null, [], {}, { keyword: "a" }, { keyword: 5 }, { keyword: "comedy", extra: 1 }, { location: "x" }, { keyword: "comedy", limit: 0 }, { keyword: "comedy", limit: 41 },
    { keyword: "comedy", radius_miles: 2 }, { keyword: "comedy", radius_miles: 50.5 }, { keyword: "comedy", sort: "price" }, { keyword: "comedy", start_date: "2026-02-30" }, { keyword: "comedy", start_date: "10/03/2026" },
    { keyword: "comedy", end_date: "2026-10-03" }, { keyword: "comedy", start_date: "2026-10-05", end_date: "2026-10-03" }, { keyword: "comedy", start_date: "2026-01-01", end_date: "2027-06-01" },
    { keyword: "comedy", local_time_from: "7pm" }, { keyword: "comedy", local_time_from: "24:00" }, { keyword: "comedy", local_time_from: "20:00", local_time_to: "18:00" }],
  get_event: [undefined, null, {}, { event: "" }, { event: 12345678 }, { event: "abc" }, { event: "not a url or id!" }, { event: "https://www.ticketmaster.com/some-page" }, { event: "090064B0EA809486", extra: 1 }],
  get_ticket_offers: [undefined, {}, { event: "abc" }, { event: "090064B0EA809486", quantity: 0 }, { event: "090064B0EA809486", quantity: 9 }, { event: "090064B0EA809486", quantity: "2" },
    { event: "090064B0EA809486", sort: "cheapest" }, { event: "090064B0EA809486", limit: 41 }, { event: "090064B0EA809486", max_price_per_ticket: 0 }, { event: "090064B0EA809486", max_price_per_ticket: "50" },
    { event: "090064B0EA809486", include_resale: "no" }, { event: "090064B0EA809486", seats: "best" }, { event: "http://www.ticketmaster.com/x/event/090064B0EA809486" }]
};
for (const [name, inputs] of Object.entries(invalidInputs)) {
  for (const input of inputs) {
    test(`${name}: rejects ${JSON.stringify(input)} before touching the page`, async () => {
      const h = harness(name, { url: "https://www.ticketmaster.com/search?q=x" });
      const result = await h.run(input);
      assert.equal(result.status, "error");
      assert.ok(["invalid_input", "unsupported_host"].includes(result.error_kind), result.error_kind);
      assert.deepEqual(h.calls.navigations, []);
      assert.deepEqual(h.calls.api, []);
      assert.equal(h.calls.js, 0);
    });
  }
}

for (const [name, input] of [["get_event", { event: "https://www.ticketweb.com/event/some-show/14208274" }], ["get_ticket_offers", { event: "https://concerts.livenation.com/some-show/event/090064B0EA809486" }], ["get_ticket_offers", { event: "https://www.ticketmaster.ca/x/event/090064B0EA809486" }], ["get_event", { event: "https://ticketmaster.com.example.net/x/event/090064B0EA809486" }]]) {
  test(`${name}: refuses other ticketing hosts (${new URL(input.event).hostname})`, async () => {
    const h = harness(name);
    const result = await h.run(input);
    assert.equal(result.error_kind, "unsupported_host");
    assert.deepEqual(h.calls.navigations, []);
    assert.deepEqual(h.calls.api, []);
    assert.equal(h.calls.js, 0);
  });
}

// --- search_events ---------------------------------------------------------------------------------

const laEvents = [
  searchEvent("AAAA0001", "Early Show", "2026-10-03T20:00:00Z", NEAR),
  searchEvent("AAAA0002", "Evening Show", "2026-10-04T02:00:00Z", NEAR),
  searchEvent("14200001", "Partner Show", "2026-10-04T03:00:00Z", NEAR, { url: "https://www.ticketweb.com/event/partner-show-tickets/14200001", id: "14200001" }),
  searchEvent("AAAA0003", "Far Show", "2026-10-04T01:00:00Z", FAR, { timeZone: "America/New_York" }),
  searchEvent("AAAA0004", "Next Day Show", "2026-10-05T02:00:00Z", NEAR),
  searchEvent("AAAA0002", "Evening Show", "2026-10-04T02:00:00Z", NEAR)
];

for (const name of ["search_events", "get_event"]) {
  for (const start of ["https://help.ticketmaster.com/hc/en-us", "https://ticketmaster.com/", "https://example.com/"]) {
    test(`${name}: refuses to run from ${start} without calling the site`, async () => {
      const h = harness(name, { url: start });
      const result = await h.run(name === "search_events" ? { keyword: "comedy" } : { event: "DDDD0001" });
      assert.equal(result.error_kind, "wrong_page");
      assert.deepEqual(h.calls.api, []);
    });
  }
}

test("search_events: stays on the current ticketmaster.com page and sends the site's own query", async () => {
  const h = harness("search_events", { url: "https://www.ticketmaster.com/event/AAAA0001", api: p => p.startsWith("/api/search/events") ? { status: 200, body: { total: 1, events: [laEvents[0]] } } : null });
  const result = await h.run({ keyword: "stand up comedy", sort: "relevance" });
  assert.equal(result.status, "ok");
  assert.deepEqual(h.calls.navigations, []);
  const params = new URLSearchParams(h.calls.api[0].split("?")[1]);
  assert.equal(params.get("q"), "stand up comedy");
  assert.equal(params.get("sort"), "relevance");
  assert.equal(params.get("region"), "200");
  assert.equal(params.get("page"), "0");
});

test("search_events: resolves a city, keeps nearby events on the requested local day and time, flags partner sites", async () => {
  const h = harness("search_events", { api: p => p.startsWith("/api/search/events") ? { status: 200, body: { total: 6, events: laEvents } } : null });
  const result = await h.run({ keyword: "comedy", location: "Los Angeles, CA", start_date: "2026-10-03", local_time_from: "17:00" });
  assert.equal(result.status, "ok");
  assert.equal(result.resolved_location.name, "Los Angeles, CA");
  assert.deepEqual(result.events.map(e => e.event_id), ["AAAA0002", "14200001"]);
  const [evening, partner] = result.events;
  assert.equal(evening.local_date, "2026-10-03");
  assert.equal(evening.local_time, "19:00");
  assert.equal(evening.weekday, "Saturday");
  assert.equal(evening.on_ticketmaster, true);
  assert.ok(evening.distance_miles < 5);
  assert.equal(partner.on_ticketmaster, false);
  assert.equal(partner.ticketing_host, "www.ticketweb.com");
  assert.deepEqual(result.events.map(e => e.rank), [1, 2]);
  // The first pass is the location-only query, whose nearby block is complete and in date order.
  const first = new URLSearchParams(h.calls.api.find(p => p.startsWith("/api/search/events")).split("?")[1]);
  assert.equal(first.get("startDate"), null);
  assert.equal(first.get("latitude"), "34.0551");
  assert.equal(first.get("distance"), "50");
  assert.equal(first.get("distanceUnit"), "miles");
});

test("search_events: prefers the city match in the requested state", async () => {
  const h = harness("search_events", { api: p => p.startsWith("/api/search/events") ? { status: 200, body: { total: 0, events: [] } } : null });
  await h.run({ keyword: "comedy", location: "Los Angeles, TX" });
  assert.ok(h.calls.api[0].startsWith("/api/discovery/location/city?city=Los%20Angeles"));
  assert.equal(new URLSearchParams(h.calls.api[1].split("?")[1]).get("latitude"), "26.49");
});

test("search_events: ZIP codes use the postal-code lookup", async () => {
  const h = harness("search_events", { api: p => p.startsWith("/api/search/events") ? { status: 200, body: { total: 0, events: [] } } : null });
  const result = await h.run({ keyword: "comedy", location: "90000" });
  assert.equal(result.status, "no_results");
  assert.equal(h.calls.api[0], "/api/discovery/location/code?code=90000");
  assert.equal(result.resolved_location.name, "90000, Los Angeles, CA");
});

test("search_events: an unknown place is location_not_found, not a search everywhere", async () => {
  const h = harness("search_events", { api: p => p.startsWith("/api/discovery") ? { status: 200, body: [] } : null });
  const result = await h.run({ keyword: "comedy", location: "Nowhereville" });
  assert.equal(result.error_kind, "location_not_found");
  assert.equal(h.calls.api.filter(p => p.startsWith("/api/search/events")).length, 0);
});

test("search_events: when the nearby block ends before the date range, it falls back to the site's date filter", async () => {
  const early = Array.from({ length: 20 }, (_, i) => searchEvent("BBBB" + String(i).padStart(4, "0"), "Soon " + i, "2026-09-27T02:00:00Z", NEAR));
  const h = harness("search_events", { api: p => {
    if (!p.startsWith("/api/search/events")) return null;
    const q = new URLSearchParams(p.split("?")[1]);
    if (!q.get("startDate")) return { status: 200, body: { total: 10000, events: early } };
    return { status: 200, body: { total: 40, events: q.get("page") === "0" ? [laEvents[3], laEvents[1]] : [] } };
  } });
  const result = await h.run({ keyword: "comedy", location: "Los Angeles", start_date: "2026-10-03" });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.events.map(e => e.event_id), ["AAAA0002"]);
  assert.equal(result.site_total, 40);
  assert.equal(h.calls.api.filter(p => p.startsWith("/api/search/events") && !p.includes("startDate")).length, 10);
});

test("search_events: sort=date orders by start time and removes duplicates", async () => {
  const h = harness("search_events", { api: p => p.startsWith("/api/search/events") ? { status: 200, body: { total: 6, events: [laEvents[4], laEvents[1], laEvents[0], laEvents[1]] } } : null });
  const result = await h.run({ keyword: "comedy", start_date: "2026-10-03", end_date: "2026-10-05" });
  assert.deepEqual(result.events.map(e => e.event_id), ["AAAA0001", "AAAA0002", "AAAA0004"]);
});

test("search_events: date-only and time-to-be-announced events are handled", async () => {
  const tba = searchEvent("CCCC0001", "TBA Show", "2026-10-03T07:00:00Z", NEAR, { tba: true, dates: { dateDisplay: "tba" } });
  const dateOnly = searchEvent("CCCC0002", "Festival", "2026-10-03T07:00:00Z", NEAR, { dates: { dateDisplay: "showDate", startDate: "2026-10-03T07:00:00Z" } });
  const h = harness("search_events", { api: p => p.startsWith("/api/search/events") ? { status: 200, body: { total: 2, events: [tba, dateOnly] } } : null });
  const all = await h.run({ keyword: "festival" });
  assert.deepEqual(all.events.map(e => [e.event_id, e.local_date, e.local_time]), [["CCCC0002", "2026-10-03", null], ["CCCC0001", null, null]]);
  const dated = await harness("search_events", { api: p => p.startsWith("/api/search/events") ? { status: 200, body: { total: 2, events: [tba, dateOnly] } } : null }).run({ keyword: "festival", start_date: "2026-10-03", local_time_from: "18:00" });
  assert.equal(dated.status, "no_results");
});

for (const [status, kind] of [[403, "challenge"], [429, "challenge"], [500, "site_error"]]) {
  test(`search_events: HTTP ${status} from the site is ${kind}`, async () => {
    const h = harness("search_events", { api: p => p.startsWith("/api/search/events") ? { status, body: { response: "block" } } : null });
    assert.equal((await h.run({ keyword: "comedy" })).error_kind, kind);
  });
}

test("search_events: a bot-protection page is reported as a challenge before any API call", async () => {
  const h = harness("search_events", { page: { title: "Your Browsing Activity Has Been Paused" } });
  const result = await h.run({ keyword: "comedy" });
  assert.equal(result.error_kind, "challenge");
  assert.deepEqual(h.calls.api, []);
});

test("search_events: a failing fetch is a site_error", async () => {
  const result = await harness("search_events", { api: () => { throw new Error("network down"); } }).run({ keyword: "comedy" });
  assert.equal(result.error_kind, "site_error");
  assert.match(result.error_message, /network down/);
});

// --- get_event -----------------------------------------------------------------------------------------

test("get_event: reads the event record by id with local times and terms notice", async () => {
  const h = harness("get_event", { url: "https://www.ticketmaster.com/search?q=comedy" });
  const result = await h.run({ event: "DDDD0001" });
  assert.equal(result.status, "ok");
  assert.equal(h.calls.api[0], "/api/eventinfo/DDDD0001");
  assert.equal(result.local_date, "2026-10-03");
  assert.equal(result.local_time, "20:30");
  assert.equal(result.doors_local_time, "19:30");
  assert.equal(result.inventory_source, "ticketmaster");
  assert.equal(result.category.sub_genre, null);
  assert.equal(result.url, "https://www.ticketmaster.com/fabricated-comedy-night/event/DDDD0001");
  assert.equal(result.terms_notice, "By proceeding you agree to the ticket terms.");
  assert.deepEqual(result.presales, [{ name: "Fan Presale", start_utc: "2026-04-28T17:00:00.000Z", end_utc: "2026-04-30T17:00:00.000Z" }]);
});

test("get_event: accepts an event URL, handles offset dates and partner inventory", async () => {
  const h = harness("get_event", { api: p => p.startsWith("/api/eventinfo/") ? { status: 200, body: eventInfo("Z1Example_Id-9", { sourceName: "TMC", timeZone: "America/New_York", dates: { startDate: "2026-10-03T19:00-04:00" }, doorsTimes: undefined }) } : null });
  const result = await h.run({ event: "https://www.ticketmaster.com/some-show-new-york-10-03-2026/event/Z1Example_Id-9?lang=en-us" });
  assert.deepEqual(h.calls.navigations, []);
  assert.equal(h.calls.api[0], "/api/eventinfo/Z1Example_Id-9");
  assert.equal(result.event_id, "Z1Example_Id-9");
  assert.equal(result.inventory_source, "partner");
  assert.equal(result.local_time, "19:00");
  assert.equal(result.start_utc, "2026-10-03T23:00:00.000Z");
  assert.equal(result.doors_local_time, null);
});

for (const [status, kind] of [[404, "not_found"], [400, "not_found"], [403, "challenge"], [502, "site_error"]]) {
  test(`get_event: HTTP ${status} is ${kind}`, async () => {
    const h = harness("get_event", { api: p => p.startsWith("/api/eventinfo/") ? { status, body: {} } : null });
    assert.equal((await h.run({ event: "DDDD0001" })).error_kind, kind);
  });
}

// --- get_ticket_offers: classic event page (offer service) -----------------------------------------------

const classic = (extra = {}) => ({ next: nextData("/naevent/[eventId]"), title: "Fabricated Game Tickets", text: "Seat Map", ...extra });

test("get_ticket_offers: best seats queries the page's offer service with quality order and quantity", async () => {
  const h = harness("get_ticket_offers", { url: "https://example.com/", page: classic() });
  const result = await h.run({ event: "EEEE0001", quantity: 4, sort: "best_seats" });
  assert.deepEqual(h.calls.navigations, ["https://www.ticketmaster.com/event/EEEE0001"]);
  assert.equal(h.calls.xhr.length, 1);
  const call = h.calls.xhr[0];
  assert.ok(call.url.startsWith("https://offeradapter.ticketmaster.com/api/ismds/event/EEEE0001/quickpicks?"));
  const q = new URLSearchParams(call.url.split("?")[1]);
  assert.equal(q.get("qty"), "4");
  assert.equal(q.get("sort"), "-quality");
  assert.equal(q.get("apikey"), FAKE_KEY);
  assert.equal(call.withCredentials, true);
  assert.ok(call.headers["TMPS-Correlation-Id"]);
  assert.equal(result.status, "ok");
  assert.equal(result.source, "inventory_api");
  assert.equal(result.sort_applied, "best_seats");
  assert.equal(result.total_listings, 3);
  assert.deepEqual(result.offers[0], {
    rank: 1, section: "101", row: "A", seats: ["1", "2", "3", "4"], area: "Lower Level, Center", ticket_type: "Resale", inventory_type: "resale",
    price_per_ticket: 250.5, base_price_per_ticket: 245.5, fees_per_ticket: 5, face_value_per_ticket: 245.5, estimated_total: 1002, seat_quality: 0.95, sellable_quantities: [2, 4]
  });
  // With two offers on one listing the cheaper one is reported.
  assert.equal(result.offers[1].price_per_ticket, 60.1);
  assert.equal(result.offers[1].area, "UPPER");
  assert.equal(result.offers[2].seats, null);
});

test("get_ticket_offers: lowest price uses the site's price order; filters apply after the query", async () => {
  const h = harness("get_ticket_offers", { url: "https://www.ticketmaster.com/event/EEEE0001", page: classic() });
  const result = await h.run({ event: "EEEE0001", include_resale: false, max_price_per_ticket: 70, limit: 1 });
  assert.deepEqual(h.calls.navigations, [], "already on the event page");
  assert.equal(new URLSearchParams(h.calls.xhr[0].url.split("?")[1]).get("sort"), "noTaxTotalprice");
  assert.equal(new URLSearchParams(h.calls.xhr[0].url.split("?")[1]).get("qty"), "2");
  assert.deepEqual(result.offers.map(o => [o.section, o.price_per_ticket, o.estimated_total]), [["205", 60.1, 120.2]]);
});

test("get_ticket_offers: filters that remove every listing are no_tickets with the reason", async () => {
  const result = await harness("get_ticket_offers", { page: classic() }).run({ event: "EEEE0001", max_price_per_ticket: 10 });
  assert.equal(result.status, "no_tickets");
  assert.match(result.reason, /None of the 3 listing\(s\) for this quantity is at or under max_price_per_ticket\.$/);
});

test("get_ticket_offers: an empty offer list on a sold-out page says so", async () => {
  const h = harness("get_ticket_offers", { page: classic({ text: "Tickets are sold out now. Check back soon." }), xhr: () => ({ status: 200, body: { total: 0, picks: [], _embedded: {} } }) });
  const result = await h.run({ event: "EEEE0001", quantity: 2 });
  assert.equal(result.status, "no_tickets");
  assert.match(result.reason, /sold out/);
  const other = await harness("get_ticket_offers", { page: classic(), xhr: () => ({ status: 200, body: { total: 0, picks: [] } }) }).run({ event: "EEEE0001", quantity: 8 });
  assert.match(other.reason, /8 tickets together/);
});

for (const [status, kind] of [[403, "challenge"], [429, "challenge"], [0, "challenge"], [500, "site_error"]]) {
  test(`get_ticket_offers: offer service status ${status} is ${kind}`, async () => {
    const result = await harness("get_ticket_offers", { page: classic(), xhr: () => ({ status, body: status === 500 ? "oops" : { error: "blocked" } }) }).run({ event: "EEEE0001" });
    assert.equal(result.error_kind, kind);
  });
}

test("get_ticket_offers: a classic page without its service configuration is unsupported_page", async () => {
  const result = await harness("get_ticket_offers", { page: { next: nextData("/naevent/[eventId]", false) } }).run({ event: "EEEE0001" });
  assert.equal(result.error_kind, "unsupported_page");
});

// --- get_ticket_offers: redirects and page types -------------------------------------------------------

test("get_ticket_offers: a waiting room is reported as queue", async () => {
  const h = harness("get_ticket_offers", { redirect: () => "https://queue.ticketmaster.com/?c=fabricated&e=fabricated" });
  const result = await h.run({ event: "EEEE0001" });
  assert.equal(result.error_kind, "queue");
  assert.ok(!result.error_message.includes("c=fabricated"), "query strings are not echoed");
});

test("get_ticket_offers: a redirect off ticketmaster.com is unsupported_host", async () => {
  const result = await harness("get_ticket_offers", { redirect: () => "https://concerts.livenation.com/event/EEEE0001" }).run({ event: "EEEE0001" });
  assert.equal(result.error_kind, "unsupported_host");
});

test("get_ticket_offers: a page that never loads is a site_error with nothing selected", async () => {
  const result = await harness("get_ticket_offers", { url: "https://example.com/", loads: false }).run({ event: "EEEE0001" });
  assert.equal(result.error_kind, "site_error");
});

test("get_ticket_offers: bot protection and missing events are named", async () => {
  assert.equal((await harness("get_ticket_offers", { page: { title: "Your Browsing Activity Has Been Paused" } }).run({ event: "EEEE0001" })).error_kind, "challenge");
  assert.equal((await harness("get_ticket_offers", { page: { next: { page: "/404", props: {} }, title: "Page Not Found" } }).run({ event: "EEEE0001" })).error_kind, "not_found");
  assert.equal((await harness("get_ticket_offers", { page: { next: { page: "/something/new", props: {} } } }).run({ event: "EEEE0001" })).error_kind, "unsupported_page");
});

// --- get_ticket_offers: newer event page (listing panel) ----------------------------------------------

const global = { next: nextData("/globalevent/[eventId]"), title: "Fabricated Show Tickets" };
const LISTINGS = {
  2: ["Select Standard, section ORCH, row J $334.88", "Select Standard, section RMEZZ, row H $1,228.85"],
  4: ["Select Standard, section ORCH, row D $476.00", "Select Verified Resale Ticket, section MEZZ, row B $500.10", "Select Standard Admission, section GA $91.95"],
  1: []
};

test("get_ticket_offers: newer layout sets the quantity filter and reads each listing once", async () => {
  const h = harness("get_ticket_offers", { page: global, panel: { listings: LISTINGS } });
  const result = await h.run({ event: "FFFF0001", quantity: 4 });
  assert.equal(result.status, "ok");
  assert.equal(result.source, "page_listing");
  assert.deepEqual(h.calls.clicks, ["Open quantity filters, current quantity: 2 Tickets", "Set quantity to: 4 Tickets"]);
  assert.equal(result.total_listings, 3);
  assert.deepEqual(result.offers.map(o => [o.ticket_type, o.section, o.row, o.inventory_type, o.price_per_ticket, o.estimated_total]), [
    ["Standard", "ORCH", "D", null, 476, 1904], ["Verified Resale Ticket", "MEZZ", "B", "resale", 500.1, 2000.4], ["Standard Admission", "GA", null, null, 91.95, 367.8]
  ]);
  assert.deepEqual(result.warnings, []);
});

test("get_ticket_offers: newer layout leaves a matching quantity alone and parses thousands", async () => {
  const h = harness("get_ticket_offers", { page: global, panel: { listings: LISTINGS } });
  const result = await h.run({ event: "FFFF0001", quantity: 2, max_price_per_ticket: 2000 });
  assert.deepEqual(h.calls.clicks, []);
  assert.equal(result.offers[1].price_per_ticket, 1228.85);
});

test("get_ticket_offers: newer layout has no Best Seats order, so it says it used lowest price", async () => {
  const result = await harness("get_ticket_offers", { page: global, panel: { listings: LISTINGS } }).run({ event: "FFFF0001", sort: "best_seats" });
  assert.equal(result.sort_requested, "best_seats");
  assert.equal(result.sort_applied, "lowest_price");
  assert.match(result.warnings[0], /only sorts by price/);
});

test("get_ticket_offers: newer layout switches a highest-price order back to lowest", async () => {
  const h = harness("get_ticket_offers", { page: global, panel: { listings: LISTINGS, sort: "Highest Price" } });
  await h.run({ event: "FFFF0001" });
  assert.deepEqual(h.calls.clicks, ["Highest Price", "Low to high Ordered by price lowest to highest"]);
});

test("get_ticket_offers: newer layout closes the picker when it stays open", async () => {
  const h = harness("get_ticket_offers", { page: global, panel: { listings: LISTINGS, stayOpen: true } });
  const result = await h.run({ event: "FFFF0001", quantity: 4 });
  assert.equal(result.status, "ok");
  assert.deepEqual(h.calls.keys, ["Escape"]);
});

test("get_ticket_offers: newer layout rejects a quantity the event does not sell and closes the picker", async () => {
  const h = harness("get_ticket_offers", { page: global, panel: { listings: LISTINGS, quantities: [1, 2, 3, 4, 5, 6] } });
  const result = await h.run({ event: "FFFF0001", quantity: 8 });
  assert.equal(result.error_kind, "invalid_input");
  assert.match(result.error_message, /1, 2, 3, 4, 5, 6/);
  assert.deepEqual(h.calls.keys, ["Escape"]);
  assert.equal(h.panel.open, false);
});

test("get_ticket_offers: newer layout reports an empty quantity as no_tickets", async () => {
  const result = await harness("get_ticket_offers", { page: global, panel: { listings: LISTINGS } }).run({ event: "FFFF0001", quantity: 1 });
  assert.equal(result.status, "no_tickets");
  assert.match(result.reason, /no seats for 1 ticket together/);
});

test("get_ticket_offers: newer layout warns that resale labelling is partial when resale is excluded", async () => {
  const result = await harness("get_ticket_offers", { page: global, panel: { listings: LISTINGS } }).run({ event: "FFFF0001", quantity: 4, include_resale: false });
  assert.deepEqual(result.offers.map(o => o.section), ["ORCH", "GA"]);
  assert.match(result.warnings.join(" "), /does not label every listing/);
});

test("get_ticket_offers: newer layout without a listing panel is a site_error, or no_tickets when the page says sold out", async () => {
  const missing = await harness("get_ticket_offers", { page: { ...global, text: "Loading" }, panel: { listings: LISTINGS, loading: true } }).run({ event: "FFFF0001" });
  assert.equal(missing.error_kind, "site_error");
  const soldOut = await harness("get_ticket_offers", { page: { ...global, text: "This event is sold out" }, panel: { listings: LISTINGS, loading: true } }).run({ event: "FFFF0001" });
  assert.equal(soldOut.status, "no_tickets");
});

// --- regressions from independent QA ------------------------------------------------------------------

test("search_events: event ids come from the ticketmaster.com URL, including _ and -", async () => {
  const withSymbols = searchEvent("999001", "Symbol Show", "2026-10-04T02:00:00Z", NEAR, { url: "https://www.ticketmaster.com/symbol-show/event/Z1ab_Cd-Ef0_" });
  const noEventPath = searchEvent("999002", "Artist Page", "2026-10-04T02:00:00Z", NEAR, { url: "https://www.ticketmaster.com/some-artist-tickets/artist/12345" });
  const h = harness("search_events", { api: p => p.startsWith("/api/search/events") ? { status: 200, body: { total: 2, events: [withSymbols, noEventPath] } } : null });
  const result = await h.run({ keyword: "symbol" });
  assert.deepEqual(result.events.map(e => e.event_id), ["Z1ab_Cd-Ef0_"]);
});

for (const name of ["get_event", "get_ticket_offers"]) {
  for (const event of ["Z1ab_Cd-Ef0_", "https://www.ticketmaster.com/symbol-show/event/Z1ab_Cd-Ef0_"]) {
    test(`${name}: accepts the event id with _ and - (${event.startsWith("http") ? "URL" : "id"})`, async () => {
      const h = harness(name, { page: classic() });
      const result = await h.run({ event });
      assert.equal(result.status, "ok");
      assert.equal(result.event_id, "Z1ab_Cd-Ef0_");
      if (name === "get_event") assert.equal(h.calls.api[0], "/api/eventinfo/Z1ab_Cd-Ef0_");
      else assert.deepEqual(h.calls.navigations, ["https://www.ticketmaster.com/event/Z1ab_Cd-Ef0_"]);
    });
  }
}

test("get_ticket_offers: include_resale false asks the offer service for primary seats only", async () => {
  const h = harness("get_ticket_offers", { page: classic(), xhr: target => {
    const q = new URLSearchParams(target.split("?")[1]);
    assert.equal(q.get("includeResale"), "false");
    return { status: 200, body: quickpicks([{ section: "400", row: "B", area: "2", offerGroups: [{ offers: ["O2"], seats: ["1", "2"] }] }]) };
  } });
  const result = await h.run({ event: "EEEE0001", include_resale: false });
  assert.deepEqual(result.offers.map(o => [o.section, o.inventory_type]), [["400", "primary"]]);
  const other = harness("get_ticket_offers", { page: classic() });
  await other.run({ event: "EEEE0001" });
  assert.equal(new URLSearchParams(other.calls.xhr[0].url.split("?")[1]).get("includeResale"), "true");
});

const pageOf = (offset, total, price) => {
  const count = Math.max(0, Math.min(40, total - offset));
  const picks = Array.from({ length: count }, (_, i) => ({ section: "S" + (offset + i), row: "1", quality: 1 - (offset + i) / 1000, area: "1", offerGroups: [{ offers: ["P" + (offset + i)], seats: ["1", "2"] }] }));
  return { total, picks, _embedded: { offer: picks.map((_, i) => offer("P" + (offset + i), "resale", price(offset + i))), area: [{ areaId: "1", description: "Floor" }] } };
};

test("get_ticket_offers: max_price_per_ticket reads further pages until it has enough, then stops", async () => {
  const h = harness("get_ticket_offers", { page: classic(), xhr: target => {
    const offset = Number(new URLSearchParams(target.split("?")[1]).get("offset"));
    return { status: 200, body: pageOf(offset, 200, i => (i >= 45 ? 50 : 500)) };
  } });
  const result = await h.run({ event: "EEEE0001", sort: "best_seats", max_price_per_ticket: 100, limit: 3 });
  assert.deepEqual(h.calls.xhr.map(c => new URLSearchParams(c.url.split("?")[1]).get("offset")), ["0", "40"]);
  assert.deepEqual(result.offers.map(o => o.section), ["S45", "S46", "S47"]);
  assert.equal(result.total_listings, 200);
  assert.deepEqual(result.warnings, []);
});

test("get_ticket_offers: max_price_per_ticket stops after three pages and says how many were checked", async () => {
  const h = harness("get_ticket_offers", { page: classic(), xhr: target => ({ status: 200, body: pageOf(Number(new URLSearchParams(target.split("?")[1]).get("offset")), 803, i => (i === 100 ? 20 : 500)) }) });
  const some = await h.run({ event: "EEEE0001", sort: "best_seats", max_price_per_ticket: 100, limit: 5 });
  assert.equal(h.calls.xhr.length, 3);
  assert.deepEqual(some.offers.map(o => o.section), ["S100"]);
  assert.match(some.warnings[0], /first 120 of 803/);
  const none = await harness("get_ticket_offers", { page: classic(), xhr: target => ({ status: 200, body: pageOf(Number(new URLSearchParams(target.split("?")[1]).get("offset")), 803, () => 500) }) }).run({ event: "EEEE0001", sort: "best_seats", max_price_per_ticket: 100 });
  assert.equal(none.status, "no_tickets");
  assert.match(none.reason, /None of the 803 listing\(s\).*among the first 120 in Best Seats order/);
  const cheapest = await harness("get_ticket_offers", { page: classic(), xhr: target => ({ status: 200, body: pageOf(Number(new URLSearchParams(target.split("?")[1]).get("offset")), 803, () => 500) }) }).run({ event: "EEEE0001", max_price_per_ticket: 100 });
  assert.equal(cheapest.status, "no_tickets");
  assert.doesNotMatch(cheapest.reason, /among the first/);
});

test("get_ticket_offers: an empty document that turns into the bot-protection page is a challenge", async () => {
  const h = harness("get_ticket_offers", { pageFor: (_, calls) => (calls.js < 3 ? { title: "", text: "" } : { title: "Your Browsing Activity Has Been Paused" }) });
  const result = await h.run({ event: "EEEE0001" });
  assert.equal(result.error_kind, "challenge");
});

test("search_events: with a location and dates the site's date-filtered results are merged into the nearby block", async () => {
  const outer = venue("Outer Club", "Irvine", "CA", 33.68, -117.83);
  const nearby = [laEvents[1], laEvents[4], ...Array.from({ length: 18 }, (_, i) => searchEvent("NEAR" + String(i).padStart(4, "0"), "Later " + i, "2026-10-10T02:00:00Z", NEAR))];
  const h = harness("search_events", { api: p => {
    if (!p.startsWith("/api/search/events")) return null;
    const q = new URLSearchParams(p.split("?")[1]);
    if (!q.get("startDate")) return { status: 200, body: { total: 10000, events: q.get("page") === "0" ? nearby : [] } };
    return { status: 200, body: { total: 5, events: q.get("page") === "0" ? [laEvents[3], searchEvent("OUTER001", "Outer Show", "2026-10-04T01:00:00Z", outer)] : [] } };
  } });
  const result = await h.run({ keyword: "comedy", location: "Los Angeles", start_date: "2026-10-03", local_time_from: "17:00" });
  assert.deepEqual(result.events.map(e => e.event_id), ["OUTER001", "AAAA0002"]);
  assert.equal(result.site_total, 5);
  assert.ok(result.events[0].distance_miles > 30 && result.events[0].distance_miles <= 50);
  const searches = h.calls.api.filter(p => p.startsWith("/api/search/events"));
  assert.equal(searches.filter(p => !p.includes("startDate")).length, 1, "the nearby block stops once it passes end_date");
  assert.equal(searches.filter(p => p.includes("startDate")).length, 1);
});
