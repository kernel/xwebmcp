import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const ORIGIN = "https://www.exploretock.com";
const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const DATE = day(30);
const sources = Object.fromEntries(["search_events", "search_restaurants", "prepare_reservation", "get_restaurant"].map(name => [name, readFileSync(new URL(`../domains/exploretock.com/${name}.js`, import.meta.url), "utf8")]));
const plain = value => JSON.parse(JSON.stringify(value));
const FAKE_TOKEN = "fabricated-secret-token";
const METRO = { slug: "exampleton", name: "Exampleton", timezone: "America/Chicago" };
const price = { priceDescription: "$20 per person", fees: [{ name: "service", type: "PERCENT", min: 20, max: 20 }], partyRangeConfigs: [{ minPartySize: 1, ticketPriceInformation: { priceType: "PREPAID", amountCents: 2000, priceDistribution: "PER_TICKET" } }] };
const business = { name: "Fabricated Bistro", domainName: "fabricated-bistro", timeZone: "America/Chicago", currencyCode: "USD", bookingsDisabled: false };
const offering = { id: 1, name: "Dinner Reservation", type: "RESERVATION", partySize: [1, 2, 3, 4], price, currencyCode: "USD" };
const prepInput = { slug: "fabricated-bistro", offering_id: 1, date: DATE, party_size: 2, time: "17:00", seating_area: "Room" };
const eventInput = { city: "exampleton", date: DATE, date_end: day(31) };
const stateHtml = state => `<script>window.$REDUX_STATE = ${JSON.stringify(state)};</script>`;
const eventRows = n => Array.from({ length: n }, (_, i) => ({ business: { ...business, domainName: `event-venue-${i}` }, offering: [{ offering: { ...offering, id: i + 1, type: "GA_EVENT", description: "Fabricated class" }, ticketGroup: [{ availableDateTime: `${DATE}T18:00` }, { availableDateTime: `${day(31)}T18:00` }] }] }));
const searchState = rows => ({ app: { config: { metroArea: [METRO] }, jwtToken: FAKE_TOKEN }, metroArea: { selectedMetroArea: METRO }, availability: { result: { offeringAvailability: rows } } });

function schemaMatches(schema, value) {
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.oneOf && schema.oneOf.filter(s => schemaMatches(s, value)).length !== 1) return false;
  if (schema.type && ![schema.type].flat().some(t => t === "null" ? value === null : t === "integer" ? Number.isInteger(value) : t === "array" ? Array.isArray(value) : t === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) : typeof value === t)) return false;
  if (typeof value === "string" && (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity) || schema.pattern && !new RegExp(schema.pattern).test(value))) return false;
  if (typeof value === "number" && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  if (Array.isArray(value) && (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity) || schema.items && !value.every(v => schemaMatches(schema.items, v)))) return false;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (schema.required?.some(k => !Object.hasOwn(value, k))) return false;
    if (schema.properties && (Object.entries(schema.properties).some(([k, s]) => k in value && !schemaMatches(s, value[k])) || schema.additionalProperties === false && Object.keys(value).some(k => !(k in schema.properties)))) return false;
  }
  return true;
}

function harness(name, options = {}) {
  const calls = { fetches: [], dom: 0 };
  const element = (text = "", query = () => null, attrs = {}) => ({
    textContent: text, querySelector: query, disabled: options.disabled ?? false, getAttribute: key => attrs[key] ?? null,
    checkVisibility: options.noVisibilityApi ? undefined : args => {
      assert.deepEqual(plain(args), { opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true });
      return options.visible !== false;
    },
    getClientRects: () => options.zeroSize ? [{ width: 0, height: 0 }] : [{ width: 100, height: 40 }]
  });
  const rows = (options.rows ?? [{ label: "5:00 PM", areas: "Bar · Room" }]).map(slot => {
    const label = element(slot.label);
    if (slot.labelVisible === false) label.checkVisibility = () => false;
    const box = element("", sel => sel === ":scope > span" ? label : sel === "p" ? element(slot.areas ?? "") : null);
    const button = options.noButton ? null : element("", undefined, { "aria-label": slot.control ?? "Book Dinner Reservation at " + slot.label, "aria-disabled": options.ariaDisabled ?? null });
    if (slot.timeVisible === false) box.checkVisibility = () => false;
    if (button && slot.buttonVisible === false) button.checkVisibility = () => false;
    const row = element("", sel => sel === '[data-testid="search-result-time"]' ? box : sel === '[data-testid="booking-card-button"]' ? button : null);
    if (slot.rowVisible === false) row.checkVisibility = () => false;
    return row;
  });
  const state = options.state ?? { app: { config: { business: { ...business, ...options.business }, metroArea: [METRO] }, jwtToken: FAKE_TOKEN }, calendar: { offerings: { experience: options.offerings ?? [offering] } }, patron: { email: "private@example.test" } };
  const context = {
    URL, URLSearchParams, Date, Intl, AbortController, setTimeout: () => 0, clearTimeout: () => {},
    window: { location: new URL(options.url ?? `${ORIGIN}/fabricated-bistro/experience/1/dinner-reservation?date=${DATE}&size=2`), $REDUX_STATE: state },
    document: { title: options.title ?? "Fabricated Bistro", readyState: options.ready ?? "complete", querySelectorAll: sel => { calls.dom++; assert.equal(sel, '[data-testid="search-result-list-item"]'); return rows; } },
    fetch: async (path, init) => {
      calls.fetches.push(path);
      assert.equal(init.credentials, "same-origin");
      assert.equal(init.method, undefined);
      const r = options.response ?? { status: 200, html: stateHtml(state) };
      if (r === "network") throw new Error("network");
      return { status: r.status, ok: r.status >= 200 && r.status < 300, headers: { get: () => null }, text: async () => r.html ?? "" };
    }
  };
  const [definition] = runInNewContext(`(${sources[name]})`, context);
  return { calls, definition, run: async input => {
    const output = plain(await definition.execute(input, { signal: options.signal }));
    assert.ok(schemaMatches(definition.tool.outputSchema, output), `schema mismatch: ${JSON.stringify(output)}`);
    assert.ok(!JSON.stringify(output).includes(FAKE_TOKEN));
    assert.ok(!JSON.stringify(output).includes("private@example.test"));
    return output;
  } };
}

const eventsHarness = (rows, options = {}) => harness("search_events", { response: { status: 200, html: stateHtml(searchState(rows)) }, ...options });

test("search_events uses EVENT/dateEnd and returns chronological event snapshots", async () => {
  const rows = eventRows(25);
  rows[0].offering[0].ticketGroup = Array.from({ length: 15 }, (_, i) => ({ availableDateTime: `${DATE}T${String(23 - i).padStart(2, "0")}:00` }));
  const h = eventsHarness(rows);
  const output = await h.run({ ...eventInput, query: "class & wine", party_size: 4 });
  assert.equal(output.status, "ok");
  assert.equal(h.calls.fetches.length, 1);
  const params = new URLSearchParams(h.calls.fetches[0].split("?")[1]);
  assert.equal(params.get("type"), "EVENT");
  assert.equal(params.get("dateEnd"), day(31));
  assert.equal(params.get("q"), "class & wine");
  assert.equal(params.get("size"), "4");
  assert.equal(output.total, 25);
  assert.equal(output.has_more, true);
  assert.equal(output.venues.length, 10);
  const event = output.venues[0].offerings[0];
  assert.equal(event.type, "GA_EVENT");
  assert.equal(event.currency, "USD");
  assert.equal(event.description, "Fabricated class");
  assert.equal(event.slot_count, 15);
  assert.equal(event.slots_truncated, true);
  assert.deepEqual(event.slots.map(s => s.local_datetime.slice(11)), ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00"]);
  const third = await h.run({ ...eventInput, page: 3 });
  assert.equal(third.venues.length, 5);
  assert.equal(third.has_more, false);
  assert.equal((await h.run({ ...eventInput, page: 4 })).status, "no_results");
  assert.equal((await eventsHarness([]).run(eventInput)).status, "no_results");
});

for (const input of [null, [], {}, { ...eventInput, date_end: "2026-13-01" }, { ...eventInput, date_end: day(29) }, { ...eventInput, date_end: day(61) }, { ...eventInput, time: "19:00" }, { ...eventInput, type: "winery" }, { ...eventInput, confirmed: true }, { ...eventInput, party_size: 21 }, { ...eventInput, page: 51 }, { ...eventInput, per_page: 21 }]) {
  test(`search_events malformed ${JSON.stringify(input)} has no site interaction`, async () => {
    const h = eventsHarness([]);
    assert.equal((await h.run(input)).error_kind, "invalid_input");
    assert.equal(h.calls.fetches.length, 0);
    assert.equal(h.calls.dom, 0);
  });
}
for (const [status, kind] of [[403, "challenge"], [429, "rate_limited"], [404, "not_found"], [503, "site_error"]]) {
  test(`search_events HTTP ${status} fails ${kind}`, async () => {
    assert.equal((await eventsHarness([], { response: { status } }).run(eventInput)).error_kind, kind);
  });
}
test("search_events wrong origin and changed state fail, with no navigation", async () => {
  const h = eventsHarness([], { url: "https://example.com/" });
  assert.equal((await h.run(eventInput)).error_kind, "wrong_page");
  assert.equal(h.calls.fetches.length, 0);
  assert.equal((await eventsHarness([], { response: { status: 200, html: "<html>changed</html>" } }).run(eventInput)).error_kind, "site_changed");
});

test("get_restaurant returns bounded published schedules, not event inventory", async () => {
  const details = { schedule: [{ date: [{ date: DATE }, { date: DATE }, { date: day(31) }, { date: "2026-02-30" }, { date: "2026-13-01" }], repetition: [{ weekday: "MONDAY" }] }], slots: [{ startTime: "18:00", endTime: "19:30" }], privateToken: FAKE_TOKEN };
  const h = harness("get_restaurant", { offerings: [{ ...offering, type: "GA_EVENT", eventDetails: details }] });
  const output = await h.run({ slug: "fabricated-bistro" });
  assert.deepEqual(output.offerings[0].event_schedule, { dates: [DATE, day(31)], times: [{ start: "18:00", end: "19:30" }], has_repetition: true, truncated: false });
  details.schedule[0].date = Array.from({ length: 102 }, (_, i) => ({ date: day(i) }));
  details.slots = Array.from({ length: 25 }, () => ({ startTime: "25:00", endTime: "19:30" }));
  const bounded = await h.run({ slug: "fabricated-bistro" });
  assert.equal(bounded.offerings[0].event_schedule.dates.length, 100);
  assert.equal(bounded.offerings[0].event_schedule.times.length, 24);
  assert.equal(bounded.offerings[0].event_schedule.times[0].start, null);
  assert.equal(bounded.offerings[0].event_schedule.truncated, true);
});

test("prepare_reservation creates an exact handoff without approving, holding, booking or paying", async () => {
  const h = harness("prepare_reservation");
  const output = await h.run(prepInput);
  assert.equal(output.status, "prepared");
  assert.equal(output.target.seating_area, "Room");
  assert.equal(output.target.offering_id, 1);
  assert.equal(output.target.time, "17:00");
  assert.equal(output.inventory_held, false);
  assert.equal(output.account_verified, false);
  assert.equal(output.final_total, null);
  assert.equal(output.execution_blocker, "trusted_human_approval_unavailable");
  assert.equal(output.pricing.amount_cents, 2000);
  assert.equal(output.pricing.currency, "USD");
  assert.equal(output.handoff_url, `${ORIGIN}/fabricated-bistro/experience/1/reservation?date=${DATE}&size=2&time=17%3A00`);
  assert.equal(h.calls.fetches.length, 0);
});
for (const input of [null, [], {}, { ...prepInput, date: "2026-02-30" }, { ...prepInput, date: "2026-13-01" }, { ...prepInput, date: day(-5) }, { ...prepInput, date: day(400) }, { ...prepInput, offering_id: 0 }, { ...prepInput, slug: "bad slug" }, { ...prepInput, party_size: "2" }, { ...prepInput, time: "24:00" }, { ...prepInput, time: "17:60" }, { ...prepInput, seating_area: " Room " }, { ...prepInput, seating_area: "x".repeat(61) }, { ...prepInput, confirmed: true }, { ...prepInput, confirm: "yes" }]) {
  test(`prepare_reservation malformed ${JSON.stringify(input)} has no site interaction`, async () => {
    const h = harness("prepare_reservation");
    assert.equal((await h.run(input)).error_kind, "invalid_input");
    assert.equal(h.calls.dom, 0);
    assert.equal(h.calls.fetches.length, 0);
  });
}
for (const [options, kind] of [
  [{ url: "https://example.com/" }, "wrong_page"], [{ url: ORIGIN + "/" }, "wrong_page"], [{ url: `${ORIGIN}/fabricated-bistro/experience/2/x?date=${DATE}&size=2` }, "wrong_page"], [{ url: `${ORIGIN}/fabricated-bistro/experience/1/x?date=${day(31)}&size=2` }, "wrong_page"],
  [{ title: "Just a moment..." }, "challenge"], [{ ready: "interactive" }, "site_changed"], [{ state: {} }, "site_changed"], [{ business: { domainName: "another-venue" } }, "site_changed"], [{ business: { domainName: 123 } }, "site_changed"],
  [{ business: { bookingsDisabled: true } }, "booking_disabled"], [{ business: { bookingsDisabled: undefined } }, "booking_disabled"], [{ business: { timeZone: "Not/AZone" } }, "site_changed"],
  [{ offerings: [{ ...offering, type: "GA_EVENT" }] }, "unsupported_offering"], [{ offerings: [{ ...offering, partySize: [4] }] }, "invalid_input"],
  [{ rows: [] }, "no_availability"], [{ rows: [{ label: "5:00 PM", control: "Join Notify list for Dinner Reservation at 5:00 PM" }] }, "notify_only"],
  [{ disabled: true }, "no_availability"], [{ ariaDisabled: "true" }, "no_availability"], [{ noButton: true }, "no_availability"],
  [{ visible: false }, "no_availability"], [{ zeroSize: true }, "no_availability"], [{ noVisibilityApi: true }, "no_availability"],
  [{ rows: [{ label: "5:00 PM", rowVisible: false }] }, "no_availability"], [{ rows: [{ label: "5:00 PM", timeVisible: false }] }, "no_availability"], [{ rows: [{ label: "5:00 PM", buttonVisible: false }] }, "no_availability"], [{ rows: [{ label: "5:00 PM", labelVisible: false }] }, "no_availability"],
  [{ rows: [{ label: "5:00 PM", control: "Book Another Offering at 5:00 PM" }] }, "no_availability"], [{ rows: [{ label: "5:00 PM" }, { label: "5:00 PM" }] }, "site_changed"],
  [{ signal: { aborted: true } }, "cancelled"]
]) {
  test(`prepare_reservation ${JSON.stringify(options)} fails ${kind} without requests`, async () => {
    const h = harness("prepare_reservation", options);
    assert.equal((await h.run(prepInput)).error_kind, kind);
    assert.equal(h.calls.fetches.length, 0);
  });
}
for (const name of ["search_events", "search_restaurants"]) {
  test(`${name} skips impossible source dates and times with a warning`, async () => {
    const rows = eventRows(1);
    if (name === "search_restaurants") rows[0].offering[0].offering.type = "RESERVATION";
    rows[0].offering[0].ticketGroup = [`${DATE}T18:00`, `${DATE}T99:99`, `${DATE}T24:00`, `${DATE}T17:60`, `${DATE}T18:00:99`, `${DATE}T18:00garbage`, "2026-02-30T18:00"].map(availableDateTime => ({ availableDateTime }));
    const h = harness(name, { response: { status: 200, html: stateHtml(searchState(rows)) } });
    const output = await h.run(name === "search_events" ? eventInput : { city: "exampleton", date: DATE });
    assert.equal(output.status, "ok");
    assert.deepEqual(output.venues[0].offerings[0].slots.map(s => s.local_datetime), [`${DATE}T18:00`]);
    assert.equal(output.venues[0].offerings[0].slot_count, 1);
    assert.ok(output.warnings.some(w => w.includes("skipped")));
  });
}
test("prepare_reservation ignores a hidden duplicate row", async () => {
  const output = await harness("prepare_reservation", { rows: [{ label: "5:00 PM", rowVisible: false }, { label: "5:00 PM", areas: "Room" }] }).run(prepInput);
  assert.equal(output.status, "prepared");
});

test("prepare_reservation seating is exact and unambiguous", async () => {
  const input = { ...prepInput }; delete input.seating_area;
  assert.equal((await harness("prepare_reservation").run(input)).error_kind, "ambiguous_seating");
  assert.equal((await harness("prepare_reservation").run({ ...prepInput, seating_area: "Patio" })).error_kind, "invalid_input");
  const single = await harness("prepare_reservation", { rows: [{ label: "17:00", areas: "Room" }] }).run(input);
  assert.equal(single.target.seating_area, "Room");
  const unnamed = await harness("prepare_reservation", { rows: [{ label: "5:00 PM", areas: "" }] }).run(input);
  assert.equal(unnamed.target.seating_area, null);
});
