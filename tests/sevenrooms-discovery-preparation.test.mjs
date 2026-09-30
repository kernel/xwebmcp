import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const NAMES = ["list_experiences", "search_events", "prepare_reservation"];
const sources = Object.fromEntries(NAMES.map(name => [name, readFileSync(new URL(`../domains/sevenrooms.com/${name}.js`, import.meta.url), "utf8")]));
const copy = value => JSON.parse(JSON.stringify(value));
const key = "fabricatedvenue";
const date = "2026-10-09";
const target = { venue_url_key: key, date, party_size: 2, local_start: date + "T19:00", label: "Patio", description_title: "Outdoor" };
const secret = "FABRICATED_SECRET_NOT_FOR_OUTPUT";
const offer = (over = {}) => ({ name: "Fabricated Dinner", landing_url_key: "fabricated-dinner", offer_type: "EXPERIENCE", is_publicly_visible: true, is_active: true, hide_on_directory: false, is_draft: false, is_inactive: false, deleted: null, public_description_text: "A public dinner.", price_description: "$12 plus fees", hide_price_description: false, created_by_user_id: secret, ...over });
const directory = experiences => ({ base_venue: { url_key: key, experiences: [] }, venues: [{ url_key: key, experiences }], client_id: secret, analytics_settings: { key: secret } });
const html = data => "<html><script>var PRELOADED = JSON.parse(" + JSON.stringify(JSON.stringify(data)) + ");</script></html>";
const event = (over = {}) => ({ id: "fabricated_event", name: "Fabricated Show", private_event: false, hide_event: false, deleted: null, event_start_time: "19:30:00", event_end_time: "20:30:00", photo_map: { url: secret }, ...over });
const eventBody = (e = event(), dates = [date]) => ({ data: { events_lookup: { [e.id]: e }, event_dates: { [e.id]: dates }, events_availabilities: { private_inventory: secret } } });
const slot = (over = {}) => ({ type: "book", real_datetime_of_slot: date + " 19:00:00", utc_datetime: "2026-10-10 02:00:00", public_time_slot_description: "Patio", public_description_title: "Outdoor", duration: 90, require_credit_card: true, cc_payment_rule: "advanced_payment", charge_type: "person", cost: 12, policy: "<p>Review all terms.</p>", cancellation_policy: "No cancellation within 48 hours.", access_persistent_id: secret, pacing_limit: 99, ...over });
const info = (over = {}, settings = {}) => ({ data: { base_venue: { name: "Fabricated Venue", url_key: key, currency_code: "USD", payment_stripe_public_key: secret, ...over }, widget_settings: { min_guests: 1, max_guests: 8, maxDaysOut: 90, ...settings } } });
const availability = (times = [slot()], extra = {}) => ({ data: { availability: { [date]: [{ name: "Dinner", shift_category: "DINNER", times, ...extra }] } } });

function conforms(s, v) {
  if (s.oneOf && s.oneOf.filter(x => conforms(x, v)).length !== 1) return false;
  if (Object.hasOwn(s, "const") && s.const !== v) return false;
  if (s.enum && !s.enum.includes(v)) return false;
  if (s.type && ![s.type].flat().some(t => t === "null" ? v === null : t === "integer" ? Number.isInteger(v) : t === "array" ? Array.isArray(v) : t === "object" ? v !== null && typeof v === "object" && !Array.isArray(v) : typeof v === t)) return false;
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    const p = s.properties || {};
    if (s.required?.some(k => !Object.hasOwn(v, k)) || (s.additionalProperties === false && Object.keys(v).some(k => !Object.hasOwn(p, k)))) return false;
    if (Object.entries(v).some(([k, x]) => p[k] && !conforms(p[k], x))) return false;
  }
  if (Array.isArray(v) && (v.length > (s.maxItems ?? Infinity) || v.length < (s.minItems ?? 0) || (s.items && v.some(x => !conforms(s.items, x))))) return false;
  if (typeof v === "string" && (v.length > (s.maxLength ?? Infinity) || v.length < (s.minLength ?? 0) || (s.pattern && !new RegExp(s.pattern).test(v)))) return false;
  if (typeof v === "string" && s.format === "uri") { try { new URL(v); } catch { return false; } }
  if (typeof v === "number" && (v < (s.minimum ?? -Infinity) || v > (s.maximum ?? Infinity))) return false;
  return true;
}

function harness(name, o = {}) {
  const calls = [];
  const timers = [];
  const controller = o.controller || new AbortController();
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : ["2026-09-30T02:00:00Z"])); }
    static now() { return Date.parse("2026-09-30T02:00:00Z"); }
  }
  const fetch = async (path, init) => {
    assert.ok(path.startsWith("/experiences/") || path.startsWith("/api-yoa/events/widget?") || path.startsWith("/api-yoa/dining/widget_info?") || path.startsWith("/api-yoa/availability/ng/widget/range?"), path);
    assert.equal(init.credentials, "omit");
    assert.equal(init.method, undefined);
    assert.equal(init.headers, undefined);
    assert.equal(init.body, undefined);
    assert.ok(init.signal instanceof AbortSignal);
    calls.push({ path, init });
    if (o.cancelDuring) queueMicrotask(() => controller.abort());
    if (o.hang || o.cancelDuring) {
      if (o.hang) queueMicrotask(() => timers.at(-1)());
      return new Promise(() => {});
    }
    if (o.networkError) throw new Error("network fault with " + secret);
    const r = o.route?.(path) || { status: 200, body: path.startsWith("/experiences/") ? html(directory([offer()])) : path.startsWith("/api-yoa/events/") ? eventBody() : path.startsWith("/api-yoa/dining/") ? info() : availability() };
    return { status: r.status ?? 200, text: async () => typeof r.body === "string" ? r.body : JSON.stringify(r.body) };
  };
  const [definition] = runInNewContext("(" + sources[name] + ")", {
    window: { location: new URL(o.url || "https://www.sevenrooms.com/events/fabricatedstart") }, fetch,
    Date: Clock, AbortController, TextEncoder, String,
    setTimeout: (fn, ms) => { assert.equal(ms, 25000); timers.push(fn); return timers.length; }, clearTimeout: () => {}
  });
  return { calls, controller, definition, run: async input => {
    const result = copy(await definition.execute(input, { signal: controller.signal }));
    assert.ok(conforms(definition.tool.outputSchema, result), JSON.stringify(result));
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.ok(new TextEncoder().encode(JSON.stringify(result)).length < 150000);
    return result;
  } };
}
const valid = name => name === "prepare_reservation" ? { ...target } : { venue_url_key: key };
const offersRoute = list => ({ route: () => ({ body: html(directory(list)) }) });
const eventsRoute = body => ({ route: () => ({ body }) });
const slotsRoute = (times, extra) => ({ route: path => path.includes("/availability/") ? { body: availability(times, extra) } : null });

for (const name of NAMES) {
  test(`${name}: definitions and sorted registry preserve the full namespace`, () => {
    const h = harness(name);
    const reg = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
    const entry = reg.tools.find(e => e.domain === "sevenrooms.com" && e.tool === name);
    assert.ok(entry);
    assert.equal(h.definition.kind, "page");
    assert.equal(h.definition.tool.name, name);
    assert.equal(h.definition.tool.annotations.readOnlyHint, true);
    assert.equal(h.definition.tool.annotations.destructiveHint, false);
    assert.deepEqual(copy(h.definition.match.url_patterns), entry.url_patterns);
    assert.ok(["draft", "qa_passed", "verified"].includes(entry.status));
    assert.deepEqual(reg.tools.filter(e => e.domain === "sevenrooms.com").map(e => e.tool), ["get_availability", "get_restaurant", "list_experiences", "prepare_reservation", "search_events"]);
  });

  test(`${name}: malformed input and fake approval fields fail before interaction`, async () => {
    for (const input of [null, [], "x", {}, { ...valid(name), venue_url_key: "../x" }, { ...valid(name), venue_url_key: "a".repeat(81) }, { ...valid(name), confirmed: true }, { ...valid(name), confirm: "yes" }, { ...valid(name), account_id: "fabricated_account" }]) {
      const h = harness(name);
      assert.equal((await h.run(input)).error_kind, "invalid_input");
      assert.equal(h.calls.length, 0);
    }
  });

  test(`${name}: unrelated pages are refused without requests`, async () => {
    for (const url of ["https://www.sevenrooms.com/login", "https://www.sevenrooms.com/", "https://www.sevenrooms.com/manager/x", "https://example.com/events/x", "https://other.sevenrooms.com/events/x", "http://www.sevenrooms.com/events/x", "https://www.sevenrooms.com/reservationsX/x"]) {
      const h = harness(name, { url });
      assert.equal((await h.run(valid(name))).error_kind, "wrong_page");
      assert.equal(h.calls.length, 0);
    }
  });

  test(`${name}: pre-canceled calls do not interact`, async () => {
    const h = harness(name); h.controller.abort();
    assert.equal((await h.run(valid(name))).error_kind, "canceled");
    assert.equal(h.calls.length, 0);
  });

  test(`${name}: cancellation and deadlines abort one request without retry`, async () => {
    for (const [opts, kind] of [[{ cancelDuring: true }, "canceled"], [{ hang: true }, "site_error"]]) {
      const h = harness(name, opts);
      assert.equal((await h.run(valid(name))).error_kind, kind);
      assert.equal(h.calls.length, 1);
      assert.equal(h.calls[0].init.signal.aborted, true);
    }
  });

  test(`${name}: blocked, login-required, rate-limited and unknown outcomes are explicit`, async () => {
    for (const [status, kind] of [[401, "login_required"], [403, "challenge"], [429, "rate_limited"], [503, "site_error"], [404, name === "prepare_reservation" ? "not_found" : "not_found"]]) {
      const h = harness(name, { route: () => ({ status, body: {} }) });
      assert.equal((await h.run(valid(name))).error_kind, kind);
      assert.equal(h.calls.length, 1);
    }
    const h = harness(name, { networkError: true });
    assert.equal((await h.run(valid(name))).error_kind, "site_error");
    assert.equal(h.calls.length, 1);
  });

  test(`${name}: source cannot select, hold, send, navigate, touch accounts or expose handles`, () => {
    assert.doesNotMatch(sources[name], /\bPOST\b|method\s*:|credentials\s*:\s*["']include|\.click\(|\.submit\(|requestSubmit|location\.(assign|replace|href\s*=)|window\.open|document\.cookie|localStorage|sessionStorage|access_persistent_id|pacing_|payment_stripe|created_by_user/);
  });
}

for (const name of ["list_experiences", "search_events"]) {
  test(`${name}: pagination bounds are checked before fetch`, async () => {
    for (const over of [{ offset: -1 }, { offset: 10001 }, { offset: "0" }, { limit: 0 }, { limit: 21 }, { limit: 1.5 }]) {
      const h = harness(name); assert.equal((await h.run({ ...valid(name), ...over })).error_kind, "invalid_input"); assert.equal(h.calls.length, 0);
    }
  });
  test(`${name}: all guest routes and authorized public hosts work without navigation`, async () => {
    for (const host of ["www", "fp", "eu"]) for (const path of ["reservations", "explore", "experiences", "events"]) {
      const h = harness(name, { url: `https://${host}.sevenrooms.com/${path}/fabricatedstart` });
      assert.equal((await h.run(valid(name))).status, "ok");
      assert.equal(h.calls[0].init.redirect, "error");
    }
  });
  test(`${name}: unexpected and oversized responses fail, not no_results`, async () => {
    for (const body of ["ordinary HTML", "x".repeat(2000001), {}, { data: [] }]) assert.equal((await harness(name, { route: () => ({ body }) }).run(valid(name))).error_kind, "site_changed");
    for (const body of ["DataDome", "Cloudflare", "captcha", "challenge", "Access Denied"]) assert.equal((await harness(name, { route: () => ({ body }) }).run(valid(name))).error_kind, "challenge");
  });
}

test("list_experiences returns only the exact venue's visible active directory offers", async () => {
  const hidden = [{ is_active: false }, { is_draft: true }, { is_publicly_visible: false }, { hide_on_directory: true }, { is_inactive: true }, { deleted: "fabricated-date" }];
  const body = directory([offer(), ...hidden.map((x, i) => offer({ ...x, landing_url_key: "hidden-" + i }))]);
  body.venues.unshift({ url_key: "anotherfabricatedvenue", experiences: [offer({ name: secret })] });
  const h = harness("list_experiences", { route: () => ({ body: html(body) }) });
  const r = await h.run(valid("list_experiences"));
  assert.equal(r.total_count, 1);
  assert.deepEqual(r.experiences[0], { landing_url_key: "fabricated-dinner", name: "Fabricated Dinner", offer_type: "EXPERIENCE", description: "A public dinner.", description_truncated: false, price_description: "$12 plus fees", url: "https://www.sevenrooms.com/experiences/fabricatedvenue/fabricated-dinner" });
  assert.equal(h.calls[0].path, "/experiences/fabricatedvenue");
});

test("list_experiences parses JSON as data, never executes a script, rejects wrong venues and duplicate keys", async () => {
  const wrong = directory([offer()]); wrong.base_venue.url_key = "anotherfabricatedvenue";
  for (const body of [html(wrong), html(directory([offer({ is_active: undefined })])), html(directory([offer(), offer()])), '<script>var PRELOADED = JSON.parse("not json"); throw 1;</script>', html(directory([offer({ landing_url_key: "../checkout" })]))]) assert.equal((await harness("list_experiences", { route: () => ({ body }) }).run(valid("list_experiences"))).error_kind, "site_changed");
  assert.doesNotMatch(sources.list_experiences, /\beval\(|\bFunction\(/);
});

test("list_experiences paginates a stable key ordering and distinguishes empty directories", async () => {
  const list = Array.from({ length: 23 }, (_, i) => offer({ landing_url_key: "offer-" + String(22 - i).padStart(2, "0") }));
  const r = await harness("list_experiences", offersRoute(list)).run({ venue_url_key: key, limit: 20 });
  assert.equal(r.total_count, 23); assert.equal(r.next_offset, 20); assert.equal(r.experiences.length, 20); assert.equal(r.experiences[0].landing_url_key, "offer-00");
  const last = await harness("list_experiences", offersRoute(list)).run({ venue_url_key: key, offset: 20 });
  assert.equal(last.experiences.length, 3); assert.equal(last.next_offset, null);
  const empty = await harness("list_experiences", offersRoute([])).run({ venue_url_key: key });
  assert.equal(empty.status, "no_results"); assert.deepEqual(empty.experiences, []); assert.equal(empty.total_count, 0);
});

test("list_experiences bounds and sanitizes every displayed string and honors hidden price text", async () => {
  const dirty = "a\u202eb\ud83dc";
  const r = await harness("list_experiences", offersRoute([offer({ name: dirty, offer_type: "a".repeat(100), public_description_text: "x".repeat(1999) + "😀z", price_description: "p".repeat(300) })])).run(valid("list_experiences"));
  assert.equal(r.experiences[0].name, "a b�c"); assert.equal(r.experiences[0].offer_type.length, 40); assert.equal(r.experiences[0].description.length, 1999); assert.equal(r.experiences[0].description_truncated, true); assert.equal(r.experiences[0].price_description.length, 200);
  const hidden = await harness("list_experiences", offersRoute([offer({ hide_price_description: true })])).run(valid("list_experiences"));
  assert.equal(hidden.experiences[0].price_description, null);
});

test("search_events validates relative-day windows before interaction", async () => {
  for (const over of [{ from_days: -1 }, { to_days: 367 }, { from_days: 10, to_days: 9 }, { from_days: 0, to_days: 31 }, { from_days: "0" }, { to_days: 0.5 }, { from_days: 367, to_days: 367 }]) {
    const h = harness("search_events"); assert.equal((await h.run({ venue_url_key: key, ...over })).error_kind, "invalid_input"); assert.equal(h.calls.length, 0);
  }
  const h = harness("search_events"); assert.equal((await h.run({ venue_url_key: key, from_days: 336, to_days: 366 })).status, "ok");
  assert.equal(h.calls[0].path, "/api-yoa/events/widget?venue=fabricatedvenue&from_days=336&to_days=366");
});

test("search_events uses server occurrence dates, never derives recurrence or ticket inventory", async () => {
  const body = eventBody(event({ is_recurring: true, start_date: "2020-01-01" }), ["2026-10-11", date, date]);
  const r = await harness("search_events", eventsRoute(body)).run(valid("search_events"));
  assert.equal(r.total_count, 2);
  assert.deepEqual(r.events, [{ event_id: "fabricated_event", name: "Fabricated Show", date, start_time: "19:30:00", end_time: "20:30:00" }, { event_id: "fabricated_event", name: "Fabricated Show", date: "2026-10-11", start_time: "19:30:00", end_time: "20:30:00" }]);
  assert.doesNotMatch(JSON.stringify(r), /inventory|price|photo|remaining_quantity/);
});

test("search_events excludes hidden/private/deleted series and validates schedule identity and dates", async () => {
  for (const over of [{ private_event: true }, { hide_event: true }, { deleted: "fabricated-date" }]) {
    const r = await harness("search_events", eventsRoute(eventBody(event(over)))).run(valid("search_events"));
    assert.equal(r.status, "no_results"); assert.deepEqual(r.events, []);
  }
  const bad = [eventBody(event({ hide_event: undefined })), eventBody(event(), ["2026-02-30"]), eventBody(event({ event_start_time: "25:00:00" })), eventBody(event({ event_end_time: "xx" }))];
  const mismatch = eventBody(); mismatch.data.events_lookup.fabricated_event.id = "different_id"; bad.push(mismatch);
  const missing = eventBody(); delete missing.data.events_lookup.fabricated_event; bad.push(missing);
  for (const body of bad) assert.equal((await harness("search_events", eventsRoute(body)).run(valid("search_events"))).error_kind, "site_changed");
});

test("search_events paginates sorted occurrences with safe nullable end times", async () => {
  const dates = Array.from({ length: 25 }, (_, i) => "2026-10-" + String(25 - i).padStart(2, "0"));
  const r = await harness("search_events", eventsRoute(eventBody(event({ event_end_time: null }), dates))).run({ venue_url_key: key });
  assert.equal(r.events.length, 20); assert.equal(r.next_offset, 20); assert.equal(r.events[0].date, "2026-10-01"); assert.equal(r.events[0].end_time, null);
  const last = await harness("search_events", eventsRoute(eventBody(event(), dates))).run({ venue_url_key: key, offset: 20 });
  assert.equal(last.events.length, 5); assert.equal(last.next_offset, null);
  const empty = { data: { events_lookup: {}, event_dates: {} } };
  assert.equal((await harness("search_events", eventsRoute(empty)).run(valid("search_events"))).status, "no_results");
});

test("prepare_reservation requires every exact target field before reading the site", async () => {
  for (const field of Object.keys(target)) {
    const input = { ...target }; delete input[field]; const h = harness("prepare_reservation");
    assert.equal((await h.run(input)).error_kind, "invalid_input", field); assert.equal(h.calls.length, 0);
  }
  for (const over of [{ party_size: 0 }, { party_size: 101 }, { local_start: "2026-02-30T19:00" }, { local_start: date + "T25:00" }, { label: "a".repeat(81) }, { label: " Patio " }, { description_title: 3 }, { date: "2026-02-30" }]) {
    const h = harness("prepare_reservation"); assert.equal((await h.run({ ...target, ...over })).error_kind, "invalid_input"); assert.equal(h.calls.length, 0);
  }
});

test("prepare_reservation returns a fresh exact target and honest manual handoff, never approval or a hold", async () => {
  const h = harness("prepare_reservation"); const r = await h.run(target);
  assert.equal(h.calls.length, 2); assert.equal(r.status, "prepared"); assert.equal(r.execution_supported, false);
  assert.match(r.execution_blocker, /No trusted human approval path/);
  assert.equal(r.handoff_url, "https://www.sevenrooms.com/explore/fabricatedvenue/reservations/create/search?date=2026-10-09&party_size=2");
  assert.equal(r.slot.local_start, target.local_start); assert.equal(r.slot.label, target.label); assert.equal(r.slot.description_title, target.description_title);
  assert.equal(r.slot.card_required, true); assert.equal(r.slot.cost, 12); assert.equal(r.slot.charge_type, "person"); assert.equal(r.currency, "USD");
  assert.equal(r.booking_policy, "Review all terms."); assert.equal(r.policies_truncated, false);
  assert.ok(r.warnings.some(w => /not a hold/.test(w))); assert.ok(r.warnings.some(w => /not a total/.test(w)));
});

test("prepare_reservation rejects unavailable/request-only/closed/ambiguous selections without writes", async () => {
  const cases = [[[], {}, "slot_unavailable"], [[slot({ type: "request" })], {}, "slot_unavailable"], [[slot({ public_time_slot_description: "Bar" })], {}, "slot_unavailable"], [[slot({ public_description_title: "Other" })], {}, "slot_unavailable"], [[slot()], { is_closed: true }, "slot_unavailable"], [[slot(), slot()], {}, "ambiguous_slot"]];
  for (const [times, extra, kind] of cases) {
    const h = harness("prepare_reservation", slotsRoute(times, extra)); const r = await h.run(target);
    assert.equal(r.error_kind, kind); assert.equal(h.calls.length, 2);
  }
});

test("prepare_reservation fails closed on mismatched venue and invalid party limits before availability", async () => {
  for (const [body, kind] of [[info({ url_key: "differentvenue" }), "site_changed"], [info({}, { min_guests: 3 }), "invalid_input"], [info({}, { max_guests: 1 }), "invalid_input"], [info({}, { min_guests: null }), "site_changed"]]) {
    const h = harness("prepare_reservation", { route: () => ({ body }) });
    assert.equal((await h.run(target)).error_kind, kind); assert.equal(h.calls.length, 1);
  }
});

test("prepare_reservation keeps post-midnight local dates and bounded terms, including cancellation-only truncation", async () => {
  const local = "2026-10-10T00:15";
  const h = harness("prepare_reservation", slotsRoute([slot({ real_datetime_of_slot: "2026-10-10 00:15:00", public_time_slot_description: null, public_description_title: null, cancellation_policy: "c".repeat(2001) })]));
  const r = await h.run({ ...target, local_start: local, label: null, description_title: null });
  assert.equal(r.slot.local_start, local); assert.equal(r.date, date); assert.equal(r.cancellation_policy.length, 2000); assert.equal(r.policies_truncated, true);
  assert.ok(r.warnings.some(w => /full terms/.test(w)));
});
