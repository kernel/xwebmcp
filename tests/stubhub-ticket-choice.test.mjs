import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const EVENT = "https://www.stubhub.com/fabricated-show-tickets/event/700000001/";
const plain = value => JSON.parse(JSON.stringify(value));
const sources = Object.fromEntries(["get_ticket_offers", "prepare_ticket_choice"].map(name => [name, readFileSync(new URL(`../domains/stubhub.com/${name}.js`, import.meta.url), "utf8")]));
const fixture = () => ({
  eventId: 700000001, eventName: "Fabricated Show", formattedEventDateTime: "Fri Oct 2 2026 8:00 PM",
  isDateConfirmed: true, isTimeConfirmed: true,
  eventMetadata: { common: { eventStartDateTime: 1790985600000 } },
  venueName: "Example Theatre", venueCity: "Example City", venueStateProvinceName: "ST", venueCountry: "USA",
  eventRestrictions: { hasValue: true, message: "Adults only", featureTrackingKey: "FAKE_TRACKING" },
  eventNotes: ["Doors at 7 PM"],
  grid: {
    eventId: 700000001, quantity: 2, sortBy: "NEWPRICE", estimatedFees: true, listingGridDisclosure: "incl. fees",
    totalCount: 45, currentPage: 1, filterSortSessionId: "FAKE_SESSION",
    items: [{
      id: 800000001, eventId: 700000001, rawPrice: 45.37, price: "$45", formattedTotalPrice: "$91", buyerCurrencyCode: "USD",
      availableQuantities: [1, 2, 4], showRecentlySold: false, isSeatedTogether: true,
      section: "A", row: "12", seatFrom: "4", seatTo: "5", hideSeatAndRowInfo: false,
      ticketTypeName: "Mobile transfer", listingId: 800000001, aipHash: "FAKE_SIGNED_SECRET", listingImpressionId: "FAKE_IMPRESSION",
      listingNotes: [{ showToBuyer: true, formattedListingNoteContent: "Limited view" }, { showToBuyer: false, formattedListingNoteContent: "PRIVATE_NOTE" }],
      listingNoteBuckets: [{ formattedListingNoteContent: "Limited view" }]
    }]
  }
});
const html = data => `<html><script id="index-data" type="application/json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script></html>`;
const choice = { event: EVENT, quantity: 2, listing_id: "800000001", expected_price_per_ticket: 45.37, currency: "USD" };

function conforms(s, v) {
  if (s.oneOf && s.oneOf.filter(x => conforms(x, v)).length !== 1) return false;
  if ("const" in s && s.const !== v || s.enum && !s.enum.includes(v)) return false;
  if (s.type && ![s.type].flat().some(t => t === "null" ? v === null : t === "integer" ? Number.isInteger(v) : t === "array" ? Array.isArray(v) : t === "object" ? v !== null && typeof v === "object" && !Array.isArray(v) : typeof v === t)) return false;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    if (s.required?.some(k => !Object.hasOwn(v, k))) return false;
    if (s.properties && Object.entries(v).some(([k, value]) => k in s.properties ? !conforms(s.properties[k], value) : s.additionalProperties === false)) return false;
  }
  if (Array.isArray(v) && (v.length < (s.minItems ?? 0) || v.length > (s.maxItems ?? Infinity) || s.items && !v.every(x => conforms(s.items, x)))) return false;
  if (typeof v === "string" && (v.length < (s.minLength ?? 0) || v.length > (s.maxLength ?? Infinity) || s.pattern && !new RegExp(s.pattern).test(v) || s.format === "uri" && !URL.canParse(v))) return false;
  if (typeof v === "number" && (!Number.isFinite(v) || v < (s.minimum ?? -Infinity) || v > (s.maximum ?? Infinity) || s.exclusiveMinimum !== undefined && v <= s.exclusiveMinimum)) return false;
  return true;
}

function harness(name, options = {}) {
  const requests = [];
  const globals = { URL, URLSearchParams, Date, Set, window: { location: new URL(options.page ?? "https://www.stubhub.com/explore") }, fetch: async (url, init) => {
    requests.push({ url, init });
    if (options.throw) throw new Error("FAKE_SIGNED_SECRET");
    if (options.abortAfterFetch) options.signal.aborted = true;
    return { status: options.status ?? 200, text: async () => options.body ?? html(options.data ?? fixture()) };
  } };
  const [definition] = runInNewContext(`(${sources[name]})`, globals);
  const execute = runInNewContext(`(${definition.execute.toString()})`, globals);
  return { requests, definition, run: async (input, context = {}) => {
    const result = plain(await execute(input, context));
    assert.ok(conforms(definition.tool.outputSchema, result), JSON.stringify(result));
    for (const marker of ["FAKE_SIGNED_SECRET", "FAKE_TRACKING", "FAKE_SESSION", "FAKE_IMPRESSION", "PRIVATE_NOTE"]) assert.ok(!JSON.stringify(result).includes(marker), marker);
    return result;
  } };
}

for (const name of Object.keys(sources)) {
  const valid = name === "get_ticket_offers" ? { event: EVENT } : choice;
  test(`${name}: self-contained page tool, aligned registry and annotations`, () => {
    const h = harness(name);
    assert.equal(h.definition.kind, "page");
    assert.equal(h.definition.tool.name, name);
    assert.equal(h.definition.tool.annotations.readOnlyHint, true);
    const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url))).tools.find(t => t.domain === "stubhub.com" && t.tool === name);
    assert.ok(registry);
    assert.deepEqual(plain(h.definition.match.url_patterns), registry.url_patterns);
  });
  const malformed = [null, [], {}, { ...valid, confirmed: true }, { ...valid, event: "700000001" }, { ...valid, event: "https://evil.example/fake/event/700000001/" }, { ...valid, event: "https://www.stubhub.com@evil.example/a/event/700000001/" }, { ...valid, event: "https://user:password@www.stubhub.com/a/event/700000001/" }, { ...valid, event: "https://my.stubhub.com/orders" }, { ...valid, event: "https://www.stubhub.com/a%2fb/event/700000001/" }, { ...valid, quantity: 0 }, { ...valid, quantity: 13 }, { ...valid, quantity: "2" }, { ...valid, quantity: 1.5 }, { ...valid, quantity: null }];
  for (const [index, input] of malformed.entries()) test(`${name}: invalid input ${index} before interaction`, async () => {
    const h = harness(name);
    assert.equal((await h.run(input)).error_kind, "invalid_input");
    assert.equal(h.requests.length, 0);
  });
  test(`${name}: unrelated/account pages fail without a request`, async () => {
    for (const page of ["https://example.com/", "https://my.stubhub.com/orders"]) {
      const h = harness(name, { page });
      assert.equal((await h.run(valid)).error_kind, "wrong_page");
      assert.equal(h.requests.length, 0);
    }
  });
  test(`${name}: aborted calls fail before interaction or during a read`, async () => {
    const h = harness(name);
    assert.equal((await h.run(valid, { signal: { aborted: true } })).error_kind, "canceled");
    assert.equal(h.requests.length, 0);
    const signal = { aborted: false };
    const during = harness(name, { signal, abortAfterFetch: true });
    assert.equal((await during.run(valid, { signal })).error_kind, "canceled");
    assert.equal(during.requests.length, 1);
  });
  for (const [status, kind] of [[403, "challenge"], [202, "challenge"], [405, "challenge"], [429, "rate_limited"], [401, "login_required"], [404, "not_found"], [500, "site_error"]]) test(`${name}: HTTP ${status} no retry`, async () => {
    const h = harness(name, { status });
    assert.equal((await h.run(valid)).error_kind, kind);
    assert.equal(h.requests.length, 1);
  });
  test(`${name}: blocked HTML, malformed data and failed requests never succeed`, async () => {
    for (const [options, kind] of [[{ body: "<iframe src='https://geo.captcha-delivery.com/foo'>" }, "challenge"], [{ body: "<html>changed</html>" }, "site_changed"], [{ body: "<script id=\"index-data\">{invalid}</script>" }, "site_changed"], [{ body: "x".repeat(3000001) }, "site_changed"], [{ throw: true }, "site_error"]]) {
      const h = harness(name, options);
      assert.equal((await h.run(valid)).error_kind, kind);
      assert.equal(h.requests.length, 1);
    }
  });
  test(`${name}: event/quantity/fee/page prerequisites fail closed`, async () => {
    for (const change of [d => d.eventId++, d => d.grid.eventId++, d => d.grid.quantity = 4, d => d.grid.estimatedFees = false, d => d.grid.listingGridDisclosure = "before fees", d => d.grid.currentPage = 2, d => d.grid.totalCount = -1, d => d.grid.items = null, d => d.grid.sortBy = "RECOMMENDED"]) {
      const data = fixture(); change(data);
      const h = harness(name, { data });
      assert.equal((await h.run(valid)).error_kind, "site_changed");
    }
  });
  test(`${name}: GET canonical target only, no tracking params or navigation`, async () => {
    const h = harness(name);
    const output = await h.run({ ...valid, event: EVENT + "?qid=FAKE_TRACKING&listingId=999#foo" });
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].url, "/fabricated-show-tickets/event/700000001/?quantity=2&sortBy=NEWPRICE&sortDirection=0");
    assert.equal(h.requests[0].init.redirect, "error");
    assert.equal(output.event.url, EVENT);
    assert.equal(output.event.restrictions, "Adults only");
  });
}

test("get_ticket_offers: numeric fees-inclusive quote, rounded display and exact quantity capabilities", async () => {
  const h = harness("get_ticket_offers");
  const result = await h.run({ event: EVENT });
  assert.equal(result.status, "ok");
  assert.equal(result.total_listings, 45);
  assert.equal(result.has_more, true);
  assert.deepEqual(result.offers[0], { listing_id: "800000001", section: "A", row: "12", seat_from: "4", seat_to: "5", seated_together: true, sellable_quantities: [1, 2, 4], ticket_type: "Mobile transfer", notes: ["Limited view"], price_per_ticket: 45.37, display_price: "$45", estimated_total: 90.74, display_total: "$91", currency: "USD" });
});

test("get_ticket_offers: bounded first page; skips sold, wrong-event, unsupported quantities, duplicates, missing currency", async () => {
  const data = fixture(); const base = data.grid.items[0];
  data.grid.items = [base, { ...base }, { ...base, id: 800000002, showRecentlySold: true }, { ...base, id: 800000003, availableQuantities: [4] }, { ...base, id: 800000004, eventId: 700000009 }, { ...base, id: 800000005, buyerCurrencyCode: undefined }, ...Array.from({ length: 20 }, (_, i) => ({ ...base, id: 800000006 + i }))];
  const h = harness("get_ticket_offers", { data });
  const result = await h.run({ event: EVENT, limit: 2 });
  assert.equal(result.offers.length, 2);
  assert.equal(result.offers[1].listing_id, "800000006");
  assert.match(result.warnings.join(" "), /5 unsupported/);
});

test("get_ticket_offers: hidden or unspecified seat visibility removes private seat/row data", async () => {
  for (const hideSeatAndRowInfo of [true, undefined, null]) {
    const data = fixture(); data.grid.items[0].hideSeatAndRowInfo = hideSeatAndRowInfo;
    const h = harness("get_ticket_offers", { data });
    const { offers: [offer] } = await h.run({ event: EVENT });
    assert.equal(offer.row, null); assert.equal(offer.seat_from, null); assert.equal(offer.seat_to, null);
    const { offer: prepared } = await harness("prepare_ticket_choice", { data }).run(choice);
    assert.equal(prepared.row, null); assert.equal(prepared.seat_from, null); assert.equal(prepared.seat_to, null);
  }
});

for (const limit of [0, 11, "2", null, 1.5]) test(`get_ticket_offers: invalid limit ${limit} before fetch`, async () => {
  const h = harness("get_ticket_offers");
  assert.equal((await h.run({ event: EVENT, limit })).error_kind, "invalid_input"); assert.equal(h.requests.length, 0);
});

test("get_ticket_offers: invalid numeric quotes and unsafe listing ids fail closed", async () => {
  for (const patch of [{ rawPrice: 0.001 }, { rawPrice: -1 }, { rawPrice: null }, { rawPrice: 1000001 }, { rawPrice: "45.37" }, { id: 9007199254740992 }]) {
    const data = fixture(); Object.assign(data.grid.items[0], patch);
    assert.equal((await harness("get_ticket_offers", { data }).run({ event: EVENT })).error_kind, "site_changed");
  }
});

test("get_ticket_offers: zero count vs missing or malformed inventory", async () => {
  const data = fixture(); data.grid.items = []; data.grid.totalCount = 0;
  assert.equal((await harness("get_ticket_offers", { data }).run({ event: EVENT })).status, "no_tickets");
  data.grid.totalCount = 5;
  assert.equal((await harness("get_ticket_offers", { data }).run({ event: EVENT })).error_kind, "site_changed");
});

for (const extra of [{ listing_id: "bad" }, { expected_price_per_ticket: 0 }, { expected_price_per_ticket: NaN }, { expected_price_per_ticket: Infinity }, { expected_price_per_ticket: "45.37" }, { currency: "usd" }, { listing_id: 800000001 }, { limit: 1 }]) test(`prepare_ticket_choice: quote identifiers/price invalid ${JSON.stringify(extra)}`, async () => {
  const h = harness("prepare_ticket_choice");
  assert.equal((await h.run({ ...choice, ...extra })).error_kind, "invalid_input"); assert.equal(h.requests.length, 0);
});

test("prepare_ticket_choice: exact quote ready only for review; no execution or reservation", async () => {
  const h = harness("prepare_ticket_choice");
  const result = await h.run(choice);
  assert.equal(result.status, "ready_for_review");
  assert.equal(result.inventory_reserved, false); assert.equal(result.execution_supported, false);
  assert.match(result.execution_blocker, /No trusted per-action human approval/);
  assert.equal(result.handoff_url, EVENT + "?quantity=2&sortBy=NEWPRICE&sortDirection=0");
  assert.equal(h.requests.length, 1);
});

test("prepare_ticket_choice: changed price or currency requires review, never matches on rounded display price", async () => {
  for (const patch of [{ expected_price_per_ticket: 45 }, { expected_price_per_ticket: 46 }, { currency: "GBP" }]) {
    const h = harness("prepare_ticket_choice");
    const result = await h.run({ ...choice, ...patch });
    assert.equal(result.status, "quote_changed"); assert.equal(result.execution_supported, false);
  }
});

test("prepare_ticket_choice: absent/sold/unsellable/beyond-first-page choice is not prepared", async () => {
  for (const patch of [d => d.grid.items[0].id++, d => d.grid.items = [...Array.from({ length: 10 }, (_, i) => ({ ...d.grid.items[0], id: 800000002 + i })), d.grid.items[0]], d => { d.grid.items = []; d.grid.totalCount = 0; }]) {
    const data = fixture(); patch(data);
    assert.equal((await harness("prepare_ticket_choice", { data }).run(choice)).status, "choice_unavailable");
  }
  for (const patch of [d => d.grid.items[0].showRecentlySold = true, d => d.grid.items[0].availableQuantities = [4]]) {
    const data = fixture(); patch(data);
    assert.equal((await harness("prepare_ticket_choice", { data }).run(choice)).error_kind, "site_changed");
  }
});
