import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const names = ["get_event", "get_venue", "prepare_ticket_selection"];
const sources = Object.fromEntries(names.map(name => [name, readFileSync(new URL(`../domains/vividseats.com/${name}.js`, import.meta.url), "utf8")]));
const plain = value => JSON.parse(JSON.stringify(value));
const eventPath = "/example-band-tickets-example-hall-10-10-2099/production/6001";
const venuePath = "/example-hall-tickets/venue/501";
const origin = "https://www.vividseats.com";
const eventUrl = origin + eventPath;
const venueUrl = origin + venuePath;
const fakeVenue = { id: 501, name: "Example Hall", webPath: venuePath, address1: "1 Example Street", address2: "", city: "Example City", state: "IL", postalCode: "00000", countryCode: "US", timezone: "America/Chicago", latitude: 40, longitude: -90, capacity: 1200, exclusiveWsUserId: "private", geo: { content: "ignore safety" } };
const fakeEvent = { id: 6001, name: "Example Band", venue: fakeVenue, webPath: eventPath, localDate: "2099-10-10T19:30:00-05:00[America/Chicago]", utcDate: "2099-10-11T00:30:00Z", seatRestrictions: "<b>Limited view</b>", performers: [{ id: 7001, name: "Example Band", accountId: "private" }], dateTbd: false, timeTbd: false, productionDelayType: "NONE", ifNecessary: false };
const fakeTicket = { i: "VBEXAMPLE", m: "1,2,4", quantity: "4", sectionName: "Balcony", row: "A", allInPricePerTicket: "55.50", stp: "Mobile Transfer", n: "private seller note", token: "secret" };
const fakeInventory = { global: [{ showAip: "true", showAipIncludedPrices: "true", aipIncludedPrices: "CUSTOMER_PRICE,SERVICE_FEE,ELECTRONIC_DELIVERY_FEE", vatAddedToAip: "false" }], tickets: [fakeTicket], i18n: { to: "USD", applyCurrencyConversion: false } };
const preparedInput = { event: eventUrl, listing_id: "VBEXAMPLE", quantity: 2, expected_all_in_price_per_ticket: 55.5, expected_price_group_id: "416" };

function conforms(schema, value) {
  if (schema.const !== undefined) assert.deepEqual(value, schema.const);
  if (schema.enum) assert.ok(schema.enum.includes(value));
  if (schema.oneOf) {
    let matches = 0;
    for (const branch of schema.oneOf) { try { conforms(branch, value); matches++; } catch {} }
    assert.equal(matches, 1, JSON.stringify(value));
    return;
  }
  if (schema.type) assert.ok([schema.type].flat().some(type => type === "null" ? value === null : type === "integer" ? Number.isInteger(value) : type === "array" ? Array.isArray(value) : type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) : typeof value === type));
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value));
    if (schema.minimum !== undefined) assert.ok(value >= schema.minimum);
    if (schema.maximum !== undefined) assert.ok(value <= schema.maximum);
    if (schema.exclusiveMinimum !== undefined) assert.ok(value > schema.exclusiveMinimum);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined) assert.ok(value.length >= schema.minLength);
    if (schema.maxLength !== undefined) assert.ok(value.length <= schema.maxLength);
    if (schema.pattern) assert.match(value, new RegExp(schema.pattern));
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined) assert.ok(value.length >= schema.minItems);
    if (schema.maxItems !== undefined) assert.ok(value.length <= schema.maxItems);
    if (schema.items) value.forEach(item => conforms(schema.items, item));
  } else if (value && typeof value === "object" && schema.properties) {
    schema.required?.forEach(key => assert.ok(Object.hasOwn(value, key), key));
    for (const [key, field] of Object.entries(value)) {
      if (schema.additionalProperties === false) assert.ok(Object.hasOwn(schema.properties, key), key);
      if (schema.properties[key]) conforms(schema.properties[key], field);
    }
  }
}

function harness(name, options = {}) {
  const calls = [];
  const document = { title: options.title ?? "Vivid Seats", cookie: options.cookie ?? "pgid=416" };
  const signal = options.signal ?? { aborted: false };
  const event = options.event === undefined ? fakeEvent : options.event;
  const venue = options.venue === undefined ? fakeVenue : options.venue;
  const inventory = options.inventory ?? fakeInventory;
  const eventData = { page: "/[slug]/production/[id]", props: { pageProps: { userData: { email: "private@example.invalid", token: "secret" }, accountId: "private", initialProductionDetailsData: { data: event } } } };
  const venueData = { page: "/[slug]/venue/[id]", props: { pageProps: { initialVenueData: { items: [venue] } } } };
  class DOMParser {
    parseFromString(text) {
      const match = /<script id="__NEXT_DATA__">([\s\S]*?)<\/script>/.exec(text);
      return { getElementById: () => match ? { textContent: match[1] } : null, body: { textContent: text.replace(/<[^>]*>/g, "") } };
    }
  }
  const [definition] = runInNewContext(`(${sources[name]})`, {
    URL, DOMParser, Date: options.Date ?? Date, URLSearchParams,
    window: { location: new URL(options.page ?? origin + "/explore") }, document,
    fetch: async (path, init) => {
      calls.push({ path, init });
      options.onRead?.(calls.length);
      assert.equal(init.method, undefined, "only GET");
      const page = !path.startsWith("/hermes/");
      assert.equal(init.redirect, page ? "manual" : "error", "redirects are never followed to account/checkout pages");
      assert.equal(init.signal, signal);
      assert.deepEqual(Object.keys(init.headers), ["accept"]);
      if (options.throws) throw new Error("private token=secret");
      if (options.cancelDuringRead) signal.aborted = true;
      if (page && options.redirected) return { type: "opaqueredirect", status: 0, ok: false, text: async () => "" };
      if (options.changeGroup && calls.length === 2) document.cookie = "pgid=21";
      const json = path.startsWith("/hermes/api/v1/listings?");
      const data = json ? inventory : path === eventPath ? (options.eventData ?? eventData) : path === venuePath ? (options.venueData ?? venueData) : null;
      assert.ok(data, "unexpected request: " + path);
      if (json && options.listingsError) return { status: 404, ok: false, text: async () => JSON.stringify({ error: options.listingsError }) };
      const status = options.http ?? 200;
      return { status, ok: status >= 200 && status < 300, text: async () => options.raw ?? (json ? JSON.stringify(data) : `<script id="__NEXT_DATA__">${JSON.stringify(data)}</script>`) };
    }
  });
  return { calls, definition, run: async input => {
    const output = plain(await definition.execute(input, { signal }));
    conforms(definition.tool.outputSchema, output);
    assert.ok(JSON.stringify(output).length < 30000);
    return output;
  } };
}
const inputFor = name => name === "get_event" ? { event: eventUrl } : name === "get_venue" ? { venue: venueUrl } : { ...preparedInput };

for (const name of names) {
  test(`${name}: self-contained single page definition, typed schemas and read annotations`, () => {
    const { definition } = harness(name);
    assert.equal(definition.kind, "page");
    assert.equal(definition.tool.name, name);
    assert.equal(definition.tool.annotations.readOnlyHint, true);
    assert.equal(definition.tool.annotations.destructiveHint, false);
    assert.equal(definition.tool.inputSchema.additionalProperties, false);
    assert.deepEqual(plain(definition.match.url_patterns), [origin + "/*"]);
    conforms(definition.tool.inputSchema, inputFor(name));
    assert.doesNotMatch(sources[name], /location\.(?:assign|replace)|requestSubmit|\.click\(|localStorage|sessionStorage|method:\s*["'](?:POST|PUT|DELETE|PATCH)/);
  });
  for (const bad of [undefined, null, [], 1, "bad", {}, { confirmed: true }, { ...inputFor(name), confirmed: true }, { ...inputFor(name), action: "checkout" }]) {
    test(`${name}: rejects malformed or approval-shaped input ${JSON.stringify(bad)}`, async () => {
      const h = harness(name);
      assert.equal((await h.run(bad)).error_kind, "invalid_input");
      assert.equal(h.calls.length, 0);
    });
  }
  for (const [page, title, expected] of [["https://example.com/", "Page", "wrong_page"], ["https://corporate.vividseats.com/", "Page", "wrong_page"], [origin, "Access Denied", "challenge"]]) {
    test(`${name}: guard ${expected} before interaction`, async () => {
      const h = harness(name, { page, title });
      assert.equal((await h.run(inputFor(name))).error_kind, expected);
      assert.equal(h.calls.length, 0);
    });
  }
  for (const [http, expected] of [[403, "challenge"], [429, "rate_limited"], [404, "not_found"], [500, "site_error"]]) {
    test(`${name}: HTTP ${http} is explicit with no retry`, async () => {
      const h = harness(name, { http });
      assert.equal((await h.run(inputFor(name))).error_kind, expected);
      assert.equal(h.calls.length, 1);
    });
  }
  for (const raw of ["<html>unexpected</html>", "<script id=\"__NEXT_DATA__\">null</script>", "<script id=\"__NEXT_DATA__\">[]</script>"]) {
    test(`${name}: changed public response is not success`, async () => assert.equal((await harness(name, { raw }).run(inputFor(name))).error_kind, "site_changed"));
  }
  for (const options of [{ signal: { aborted: true } }, { cancelDuringRead: true }]) {
    test(`${name}: cancellation causes no follow-on reads or mutations`, async () => {
      const h = harness(name, options);
      assert.equal((await h.run(inputFor(name))).error_kind, "canceled");
      assert.ok(h.calls.length <= 1);
    });
  }
  test(`${name}: network exception does not leak underlying error or retry`, async () => {
    const h = harness(name, { throws: true });
    const result = await h.run(inputFor(name));
    assert.equal(result.error_kind, "site_error");
    assert.doesNotMatch(JSON.stringify(result), /private|token=|secret/);
    assert.equal(h.calls.length, 1);
  });
  const target = name === "get_venue" ? "venue" : "event";
  for (const value of ["123", "https://www.vividseats.com/shop/viewCart.shtml", eventUrl.replace("https:", "http:"), "https://user:password@www.vividseats.com" + eventPath, origin + ":8443" + eventPath, origin + "/%2e%2e/production/6001", origin + "/example/production/0"]) {
    test(`${name}: invalid URL ${value}`, async () => {
      const h = harness(name);
      assert.equal((await h.run({ ...inputFor(name), [target]: value })).status, "error");
      assert.equal(h.calls.length, 0);
    });
  }
  for (const host of ["evil.example", "www.vividseats.com.evil.example", "corporate.vividseats.com"]) {
    test(`${name}: rejects host ${host} before reads`, async () => {
      const h = harness(name);
      assert.equal((await h.run({ ...inputFor(name), [target]: `https://${host}` + (target === "event" ? eventPath : venuePath) })).error_kind, "unsupported_host");
      assert.equal(h.calls.length, 0);
    });
  }
}

test("get_event: allowlisted details from an unrelated domain page, no prices/private SSR", async () => {
  const h = harness("get_event");
  const out = await h.run({ event: eventUrl + "?quantity=2&token=secret#fragment" });
  assert.equal(out.status, "ok");
  assert.equal(out.event.start_utc, "2099-10-11T00:30:00.000Z");
  assert.equal(out.event.local_time, "19:30");
  assert.equal(out.event.seat_restrictions, "Limited view");
  assert.equal(out.event.venue.url, venueUrl);
  assert.equal(out.event.venue.address_line_1, "1 Example Street");
  assert.doesNotMatch(JSON.stringify(out), /private|secret|accountId|token|exclusiveWs|geo|article/);
  assert.deepEqual(h.calls.map(c => c.path), [eventPath]);
});
for (const flag of ["dateTbd", "timeTbd"]) {
  test(`get_event: ${flag} masks placeholder instants`, async () => {
    const out = await harness("get_event", { event: { ...fakeEvent, [flag]: true } }).run({ event: eventUrl });
    assert.equal(out.event.start_utc, null);
    assert.equal(out.event.local_time, null);
    if (flag === "dateTbd") assert.equal(out.event.local_date, null);
  });
}
for (const event of [null, { ...fakeEvent, id: 6002 }, { ...fakeEvent, webPath: "/other/production/6001" }, { ...fakeEvent, venue: null }, { ...fakeEvent, name: "" }]) {
  test("get_event: wrong/missing identity is site_changed", async () => assert.equal((await harness("get_event", { event }).run({ event: eventUrl })).error_kind, "site_changed"));
}
test("get_event: bounded performer and restriction text", async () => {
  const out = await harness("get_event", { event: { ...fakeEvent, name: "x".repeat(400), seatRestrictions: "x".repeat(2000), performers: Array(100).fill({ id: 1, name: "x".repeat(400) }) } }).run({ event: eventUrl });
  assert.equal(out.event.performers.length, 10);
  assert.equal(out.event.name.length, 200);
  assert.equal(out.event.seat_restrictions.length, 1000);
});
test("get_venue: exact capacity/address, no marketing HTML", async () => {
  const out = await harness("get_venue").run({ venue: venueUrl });
  assert.equal(out.status, "ok");
  assert.equal(out.venue.capacity, 1200);
  assert.equal(out.venue.latitude, 40);
  assert.doesNotMatch(JSON.stringify(out), /private|secret|exclusiveWs|geo|article/);
});
for (const venue of [null, { ...fakeVenue, id: 502 }, { ...fakeVenue, webPath: "/wrong/venue/501" }]) {
  test("get_venue: wrong identity fails closed", async () => assert.equal((await harness("get_venue", { venue }).run({ venue: venueUrl })).error_kind, "site_changed"));
}
test("get_venue: absent or malformed catalog values are null", async () => {
  const out = await harness("get_venue", { venue: { ...fakeVenue, capacity: -1, latitude: 200, longitude: "1", address2: "" } }).run({ venue: venueUrl });
  assert.equal(out.venue.capacity, null);
  assert.equal(out.venue.latitude, null);
  assert.equal(out.venue.longitude, null);
  assert.equal(out.venue.address_line_2, null);
});

test("prepare_ticket_selection: exact quote, no site selection/hold/cart/checkout", async () => {
  const h = harness("prepare_ticket_selection");
  const out = await h.run(preparedInput);
  assert.equal(out.status, "prepared");
  assert.equal(out.selection.listing_id, "VBEXAMPLE");
  assert.equal(out.selection.estimated_total, 111);
  assert.equal(out.inventory_reserved, false);
  assert.equal(out.site_selection_made, false);
  assert.equal(out.handoff_url, eventUrl + "?quantity=2");
  assert.equal(out.selection.seat_numbers, null);
  assert.deepEqual(out.selection.price_basis.includes, ["listing_price", "service_fee", "electronic_delivery_fee"]);
  assert.doesNotMatch(JSON.stringify(out), /private seller|secret/);
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every(c => c.path === eventPath || /^\/hermes\/api\/v1\/listings\?productionId=6001&currency=USD&localizeCurrency=true&priceGroupId=416$/.test(c.path)));
});
for (const changes of [{ quantity: null }, { quantity: 0 }, { quantity: 9 }, { quantity: 1.2 }, { listing_id: null }, { listing_id: "../" }, { expected_all_in_price_per_ticket: null }, { expected_all_in_price_per_ticket: "55.50" }, { expected_all_in_price_per_ticket: 55.501 }, { expected_all_in_price_per_ticket: NaN }, { expected_all_in_price_per_ticket: Infinity }, { expected_price_group_id: undefined }, { expected_price_group_id: 416 }, { expected_price_group_id: "416;secret" }]) {
  test("prepare_ticket_selection: invalid parameter before interaction", async () => {
    const h = harness("prepare_ticket_selection");
    assert.equal((await h.run({ ...preparedInput, ...changes })).error_kind, "invalid_input");
    assert.equal(h.calls.length, 0);
  });
}
for (const options of [{ cookie: "pgid=21" }, { cookie: "" }]) {
  test("prepare_ticket_selection: mismatched session group makes zero requests", async () => {
    const h = harness("prepare_ticket_selection", options);
    assert.equal((await h.run(preparedInput)).error_kind, "stale_selection");
    assert.equal(h.calls.length, 0);
  });
}
test("prepare_ticket_selection: default group can be explicitly reviewed as null", async () => {
  const out = await harness("prepare_ticket_selection", { cookie: "" }).run({ ...preparedInput, expected_price_group_id: null });
  assert.equal(out.status, "prepared");
  assert.equal(out.selection.price_group_id, null);
});
for (const event of [{ ...fakeEvent, dateTbd: true }, { ...fakeEvent, timeTbd: true }, { ...fakeEvent, localDate: "2019-12-31T18:00:00-06:00[America/Chicago]", utcDate: "2020-01-01T00:00:00Z" }, { ...fakeEvent, utcDate: null }, { ...fakeEvent, localDate: null }]) {
  test("prepare_ticket_selection: started or unspecified event cannot be prepared", async () => {
    const h = harness("prepare_ticket_selection", { event });
    assert.equal((await h.run(preparedInput)).error_kind, "event_unavailable");
    assert.equal(h.calls.length, 1);
  });
}
for (const [tickets, expected] of [[[], "listing_unavailable"], [[{ ...fakeTicket, i: "OTHER" }], "listing_unavailable"], [[fakeTicket, fakeTicket], "site_changed"], [[{ ...fakeTicket, m: "1,4" }], "quantity_unavailable"], [[{ ...fakeTicket, m: "2junk" }], "site_changed"], [[{ ...fakeTicket, quantity: "4junk" }], "site_changed"], [[{ ...fakeTicket, allInPricePerTicket: "56.00" }], "stale_selection"], [[{ ...fakeTicket, allInPricePerTicket: "unknown" }], "site_changed"]]) {
  test(`prepare_ticket_selection: listing prerequisite ${expected}`, async () => assert.equal((await harness("prepare_ticket_selection", { inventory: { ...fakeInventory, tickets } }).run(preparedInput)).error_kind, expected));
}
for (const changes of [{ showAip: "false" }, { aipIncludedPrices: "" }, { vatAddedToAip: undefined }, { aipIncludedPrices: "CUSTOMER_PRICE,bad" }]) {
  test("prepare_ticket_selection: unknown fee basis is not guessed", async () => assert.equal((await harness("prepare_ticket_selection", { inventory: { ...fakeInventory, global: [{ ...fakeInventory.global[0], ...changes }] } }).run(preparedInput)).error_kind, "price_basis_unavailable"));
}
test("prepare_ticket_selection: non-USD conversion fails closed", async () => assert.equal((await harness("prepare_ticket_selection", { inventory: { ...fakeInventory, i18n: { to: "USD", applyCurrencyConversion: true } } }).run(preparedInput)).error_kind, "site_changed"));
test("prepare_ticket_selection: price group changed during the read is stale", async () => assert.equal((await harness("prepare_ticket_selection", { changeGroup: true }).run(preparedInput)).error_kind, "stale_selection"));
for (const formattedDate of [{ date: "Date TBD", time: "7:30pm" }, { date: "Wed, Sep 30", time: "Time TBD" }]) {
  test("public detail TBD labels without boolean flags suppress placeholder times", async () => {
    const event = { ...fakeEvent, dateTbd: undefined, timeTbd: undefined, formattedDate };
    const read = await harness("get_event", { event }).run({ event: eventUrl });
    assert.equal(read.event.start_utc, null);
    assert.equal(read.event.local_time, null);
    const h = harness("prepare_ticket_selection", { event });
    assert.equal((await h.run(preparedInput)).error_kind, "event_unavailable");
    assert.equal(h.calls.length, 1);
  });
}

for (const changes of [
  { localDate: "2099-10-10T23:59:00-05:00[US/Central]", utcDate: "2099-10-10T23:59:00Z", formattedDate: { time: "Time TBD" }, timeTbd: undefined },
  { localDate: "2099-10-10T25:99:00-05:00[America/Chicago]", timeTbd: true },
  { localDate: "2099-02-30T25:99:00-05:00[America/Chicago]", utcDate: "invalid", dateTbd: true }
]) {
  test("TBD placeholders are masked before instant validation", async () => {
    const event = { ...fakeEvent, ...changes };
    const out = await harness("get_event", { event }).run({ event: eventUrl });
    assert.equal(out.status, "ok");
    assert.equal(out.event.local_time, null);
    assert.equal(out.event.start_utc, null);
    assert.equal(out.event.local_date, event.dateTbd ? null : "2099-10-10");
    const h = harness("prepare_ticket_selection", { event });
    assert.equal((await h.run(preparedInput)).error_kind, "event_unavailable");
    assert.equal(h.calls.length, 1);
  });
}
for (const changes of [
  { localDate: "2099-02-30T25:99:00-05:00[America/Chicago]" },
  { localDate: "2099-02-30T19:30:00-06:00[America/Chicago]" },
  { localDate: "2020-10-10T19:30:00-05:00[America/Chicago]" },
  { localDate: "2099-10-10T19:30:00-24:00[America/Chicago]" },
  { localDate: "2099-10-10T19:30:00-05:60[America/Chicago]" },
  { localDate: "2099-10-10T19:30:00-05:00[Europe/London]" },
  { localDate: "2099-10-10T19:30:00-05:00[Invalid/Zone]" },
  { utcDate: "2099-02-30T00:30:00Z" },
  { utcDate: "October 11, 2099" },
  { utcDate: "2099-10-11T00:31:00Z" }
]) {
  for (const name of ["get_event", "prepare_ticket_selection"]) {
    test(`${name}: rejects inconsistent or invalid event timestamps ${JSON.stringify(changes)}`, async () => {
      const h = harness(name, { event: { ...fakeEvent, ...changes } });
      assert.equal((await h.run(inputFor(name))).error_kind, "site_changed");
      assert.equal(h.calls.length, 1);
    });
  }
}
for (const changes of [
  { localDate: "2096-02-29T19:30:00-06:00[America/Chicago]", utcDate: "2096-03-01T01:30:00Z" },
  { localDate: "2099-10-10T19:30-05:00[America/Chicago]", utcDate: "2099-10-11T00:30:00.000Z" },
  { localDate: "2099-10-10T19:30:00-05:00", utcDate: "2099-10-11T00:30:00Z" }
]) {
  test("prepare_ticket_selection: valid leap date and equivalent ISO formats", async () => {
    assert.equal((await harness("prepare_ticket_selection", { event: { ...fakeEvent, ...changes } }).run(preparedInput)).status, "prepared");
  });
}
test("prepare_ticket_selection: rejects event that starts during the inventory read", async () => {
  let now = Date.parse(fakeEvent.utcDate) - 1000;
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const h = harness("prepare_ticket_selection", { Date: Clock, onRead: count => { if (count === 2) now += 2000; } });
  assert.equal((await h.run(preparedInput)).error_kind, "event_unavailable");
  assert.equal(h.calls.length, 2);
});

test("prepare_ticket_selection: no duplicate write or state cache on repeat", async () => {
  const h = harness("prepare_ticket_selection");
  assert.equal((await h.run(preparedInput)).status, "prepared");
  assert.equal((await h.run(preparedInput)).status, "prepared");
  assert.equal(h.calls.length, 4);
});

test("prepare_ticket_selection: the listings proxy's generic 404 before user input is not a missing listing", async () => {
  const early = harness("prepare_ticket_selection", { listingsError: "Request failed with status code 404" });
  const result = await early.run(preparedInput);
  assert.equal(result.error_kind, "site_error");
  assert.match(result.error_message, /not serving listings.*get_ticket_offers/);
  assert.equal(early.calls.length, 2, "one read of the event page and one of the listings, no retry");
  assert.equal((await harness("prepare_ticket_selection", { listingsError: "No production" }).run(preparedInput)).error_kind, "not_found");
});

test("prepare_ticket_selection: an event page that redirects, as an unknown event does to /404, is not_found without following it", async () => {
  const h = harness("prepare_ticket_selection", { redirected: true });
  const result = await h.run(preparedInput);
  assert.equal(result.error_kind, "not_found");
  assert.equal(h.calls.length, 1, "neither the redirect target nor the listings are read");
});

for (const name of ["get_event", "get_venue"]) test(`${name}: a page that redirects, as an unknown ${name === "get_event" ? "event" : "venue"} does to /404, is not_found without following it`, async () => {
  const h = harness(name, { redirected: true });
  const out = await h.run(inputFor(name));
  assert.equal(out.status, "error"); assert.equal(out.error_kind, "not_found");
  assert.equal(h.calls.length, 1, "the redirect target is not read");
});
