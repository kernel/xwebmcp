import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { webcrypto, createHash } from "node:crypto";
import test from "node:test";

// Stateful fake of Resy's booking, rating, list-sharing and discovery endpoints. Everything is fabricated.
const names = ["get_booking_quote", "book_reservation", "change_reservation", "cancel_reservation", "rate_reservation", "get_share_link", "copy_list", "get_venues", "list_events", "list_collections", "get_collection"];
const sources = Object.fromEntries(names.map(n => [n, readFileSync(new URL(`../domains/resy.com/${n}.js`, import.meta.url), "utf8")]));
const key = "fabricatedclientkey00000000000000";
const token = "fabricated-session-token";
const accountId = 12345;
const ref = id => "account_" + createHash("sha256").update("resy.com/account/" + id).digest("hex");
const account = ref(accountId);
const NOW = "2026-09-30T01:00:00Z";

function conforms(s, v) {
  if (s.oneOf && s.oneOf.filter(x => conforms(x, v)).length !== 1) return false;
  if ("const" in s && s.const !== v || s.enum && !s.enum.includes(v)) return false;
  if (s.type && ![s.type].flat().some(t => t === "null" ? v === null : t === "object" ? v !== null && typeof v === "object" && !Array.isArray(v) : t === "integer" ? Number.isInteger(v) : t === "array" ? Array.isArray(v) : typeof v === t)) return false;
  if (Array.isArray(v) && (v.length < (s.minItems ?? 0) || v.length > (s.maxItems ?? Infinity) || s.items && !v.every(x => conforms(s.items, x)))) return false;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    if (s.required?.some(k => !Object.hasOwn(v, k))) return false;
    if (s.additionalProperties === false && Object.keys(v).some(k => !Object.hasOwn(s.properties || {}, k))) return false;
    if (Object.entries(s.properties || {}).some(([k, p]) => k in v && !conforms(p, v[k]))) return false;
  }
  if (typeof v === "string" && (v.length < (s.minLength ?? 0) || v.length > (s.maxLength ?? Infinity) || s.pattern && !new RegExp(s.pattern).test(v))) return false;
  if (typeof v === "number" && (v < (s.minimum ?? -Infinity) || v > (s.maximum ?? Infinity))) return false;
  return true;
}

const slotAt = (time, type = "Dining Room") => ({ date: { start: "2026-10-09 " + time + ":00", end: "2026-10-09 21:00:00" }, config: { type, token: "rgs://private/" + time } });
const venueRow = id => ({ id: { resy: id }, name: "Fabricated " + id, url_slug: "fabricated-" + id, type: "Italian", price_range_id: 2, rater: [{ score: 4.4, total: 9 }], location: { url_slug: "exampleton-xa", neighborhood: "Old Quarter" } });

function harness(name, o = {}) {
  const requests = [];
  const state = {
    upcoming: o.upcoming ?? [], past: o.past ?? [],
    slots: o.slots ?? [slotAt("19:00"), slotAt("19:30"), slotAt("20:00", "Bar")],
    total: o.total ?? 0, fee: o.fee === undefined ? 25 : o.fee, paymentType: o.paymentType ?? "free",
    methods: o.methods ?? [{ id: 77, is_default: true, display: "private-card" }],
    lists: [{ list_id: "LIST-1", name: "Weekend", url_slug: "SHARE-1", is_public: false, is_legacy_hitlist: false, count: 2 }], next: 5000
  };
  const resRow = r => ({ reservation_id: r.id, venue: { id: r.venue_id, currency: "USD" }, day: r.day, time_slot: r.time + ":00", num_seats: r.seats, config: { type: r.seating ?? "Dining Room" }, resy_token: "rr://private/" + r.id, cancellation: r.cancellation, change: r.change ?? { allowed: true }, rating: r.rating ?? null, special_request: "private-request" });
  const page = list => ({ reservations: list.map(resRow), venues: Object.fromEntries(list.map(r => [r.venue_id, { name: "Fabricated " + r.venue_id }])), metadata: { total: o.totalOverride ?? list.length } });
  const window = { location: { origin: "https://resy.com" }, apiConfig: { Config: { apiKey: key } }, apiAuthToken: o.loggedOut ? undefined : token };
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [NOW])); } static now() { return Date.parse(NOW); } }
  const parseForm = b => Object.fromEntries(new URLSearchParams(b));
  const serve = (method, url, body) => {
    const path = url.pathname;
    let m;
    if (path === "/2/user") return { body: { id: accountId } };
    if (path === "/3/user/reservations") return { body: page(url.searchParams.get("type") === "past" ? state.past : state.upcoming) };
    if (path === "/4/find") return { body: { query: { day: body.day, party_size: body.party_size }, results: { venues: [{ venue: { id: { resy: body.venue_id }, name: "Fabricated " + body.venue_id }, slots: state.slots }] } } };
    if (path === "/3/details") {
      const out = { payment: { amounts: { total: state.total, reservation_charge: state.total, tax: 0 }, config: { type: state.paymentType } }, cancellation: { fee: { amount: state.fee, date_cut_off: "2026-10-09T17:00:00Z" }, refund: { date_cut_off: "2026-10-09T17:00:00Z" }, display: { policy: ["<b>Fabricated policy</b>"] } }, change: { date_cut_off: "2026-10-09T17:00:00Z" }, locale: { currency: "USD" } };
      if (body.commit === 1) { out.book_token = { value: "bt://private/" + body.config_id, date_expires: "soon" }; out.user = { payment_methods: state.methods }; }
      return { status: body.commit === 1 ? o.commitStatus ?? 201 : 200, body: out };
    }
    if (path === "/3/book") {
      const f = parseForm(body);
      const time = f.book_token.split("/").pop();
      state.upcoming.push({ id: ++state.next, venue_id: 1001, day: "2026-10-09", time, seats: 2, cancellation: { fee: { amount: state.fee, date_cut_off: "2026-10-09T17:00:00Z" } } });
      return { status: 201, body: { resy_token: "rr://private/new", reservation_id: state.next } };
    }
    if (path === "/3/change") {
      const f = parseForm(body);
      const r = state.upcoming.find(x => "rr://private/" + x.id === f.resy_token);
      const slot = state.slots.find(x => f.book_token === "bt://private/" + x.config.token);
      r.time = f.book_token.split("/").pop();
      r.seating = slot.config.type;
      return { body: {} };
    }
    if (path === "/3/cancel") { const f = parseForm(body); state.upcoming = state.upcoming.filter(x => "rr://private/" + x.id !== f.resy_token); return { body: {} }; }
    if (path === "/3/rate/reservation") { const f = parseForm(body); const r = state.past.find(x => "rr://private/" + x.id === f.resy_token); r.rating = { value: Number(f.rating), expired: false }; return { body: {} }; }
    if (method === "GET" && path === "/3/user/lists") return { body: { results: { lists: state.lists.map(l => ({ ...l, description: null })) }, metadata: { total: state.lists.length } } };
    if ((m = /^\/3\/user\/lists\/([A-Za-z0-9-]+)\/share$/.exec(path))) { const l = state.lists.find(x => x.list_id === m[1]); return l ? { body: { url_slug: l.url_slug } } : { status: 404, body: {} }; }
    if ((m = /^\/3\/user\/lists\/([A-Za-z0-9-]+)\/view$/.exec(path))) { const l = state.lists.find(x => x.url_slug === m[1]); return l ? { body: { list: { name: l.name, count: l.count }, results: { venues: [] }, created_by: { first_name: "Private" } } } : { status: 404, body: {} }; }
    if ((m = /^\/3\/user\/lists\/([A-Za-z0-9-]+)\/copy$/.exec(path))) { const l = state.lists.find(x => x.url_slug === m[1]); state.lists.push({ ...l, list_id: "COPY-" + ++state.next, url_slug: "SHARE-" + state.next }); return { body: {} }; }
    if (path === "/3/venues") return { body: { results: { venues: url.searchParams.get("venue_ids").split(",").map(Number).filter(id => id < 9000).map(venueRow) }, metadata: { total: 0 } } };
    if (path === "/3/events/location") { const all = Array.from({ length: 7 }, (_, i) => ({ name: "Event " + i, date: "2026-10-09", time: "18:00:00", end_time: "21:00:00", url_slug: "event-" + i, max_party_size: 8, price_summary: { min: 40, max: 80, currency: "USD" }, preview: "Fabricated", venue: { id: 1001, name: "Fabricated 1001", url_slug: "fabricated-1001", location: { url_slug: "exampleton-xa" } } })); const p = Number(url.searchParams.get("offset")), l = Number(url.searchParams.get("limit")); return { body: { results: { events: p < 1 ? [] : all.slice((p - 1) * l, p * l) }, metadata: { total: 7 } } }; }
    if (path === "/3/events/upcoming") return { body: { events: [{ name: "Venue night", date: "2026-10-09", time: "19:00:00", url_slug: "night", venue: { id: 1001, name: "Fabricated 1001", url_slug: "fabricated-1001", location: { url_slug: "exampleton-xa" } } }] } };
    if (path === "/3/collections") return { body: [{ id: 954, info: { name: "My Hit List", type_id: 8 } }, { id: 889, info: { name: "Climbing", description: "Fabricated", type_id: 3 } }] };
    if (path === "/3/collection/venues") return { body: { query: {}, results: { venues: [{ venue: venueRow(1001), slots: Array.from({ length: 9 }, (_, i) => slotAt("1" + i + ":00")).reverse() }, { venue: { name: "no id" } }] } } };
    return { status: 404, body: {} };
  };
  const ctx = { window, URL, URLSearchParams, Date: FixedDate, crypto: webcrypto, TextEncoder, Uint8Array, AbortController, setTimeout, clearTimeout, fetch: async (href, init) => {
    const url = new URL(href);
    assert.equal(url.origin, "https://api.resy.com");
    assert.equal(init.credentials, "omit");
    const body = init.body === undefined ? undefined : init.headers["Content-Type"] === "application/json" ? JSON.parse(init.body) : init.body;
    requests.push({ method: init.method, path: url.pathname, url, body, init });
    const forced = await o.route?.({ path: url.pathname, body, state, window });
    if (forced instanceof Error) throw forced;
    const r = forced ?? serve(init.method, url, body);
    if (["/3/book", "/3/change", "/3/cancel", "/3/rate/reservation"].includes(url.pathname) && o.afterWrite) o.afterWrite({ state, window });
    return { status: r.status ?? 200, text: async () => r.raw ?? JSON.stringify(r.body) };
  } };
  const [definition] = runInNewContext(`(${sources[name]})`, ctx);
  const paths = () => requests.map(r => r.path + (r.path === "/3/details" ? ":" + r.body.commit : ""));
  return { requests, state, window, definition, paths, writes: () => requests.filter(r => ["/3/book", "/3/change", "/3/cancel", "/3/rate/reservation", "/3/user/lists/LIST-1/share"].includes(r.path) || r.path.endsWith("/copy")), run: async (input, context) => {
    const output = JSON.parse(JSON.stringify(await definition.execute(input, context)));
    assert.ok(conforms(definition.tool.outputSchema, output), JSON.stringify(output));
    const raw = JSON.stringify(output);
    for (const secret of [key, token, "rgs://", "rr://", "bt://", "private-card", "private-request", "Private"]) assert.equal(raw.includes(secret), false, secret);
    return output;
  } };
}

const slot = { venue_id: 1001, date: "2026-10-09", party_size: 2, local_start: "2026-10-09T19:00", seating_type: "Dining Room" };
const valid = {
  get_booking_quote: { expected_account_ref: account, ...slot },
  book_reservation: { expected_account_ref: account, ...slot, expected_total: 0, confirm: true },
  change_reservation: { expected_account_ref: account, reservation_id: "4001", expected_date: "2026-10-09", ...slot, local_start: "2026-10-09T19:30", expected_total: 0, confirm: true },
  cancel_reservation: { expected_account_ref: account, reservation_id: "4001", expected_venue_id: 1001, expected_date: "2026-10-09", confirm: true },
  rate_reservation: { expected_account_ref: account, reservation_id: "3001", rating: 4, confirm: true },
  get_share_link: { expected_account_ref: account, list_id: "LIST-1" },
  copy_list: { expected_account_ref: account, list_slug: "SHARE-1", allow_duplicate: true },
  get_venues: { venue_ids: [1001, 1002] },
  list_events: { location: "xa", start_date: "2026-10-09" },
  list_collections: { location: "xa" },
  get_collection: { collection_id: 889, location: "xa", date: "2026-10-09" }
};
const booked = { id: 4001, venue_id: 1001, day: "2026-10-09", time: "19:00", seats: 2, cancellation: { fee: { amount: 25, date_cut_off: "2026-10-09T17:00:00Z" } } };
const accountTools = names.slice(0, 7);

for (const name of names) {
  test(`${name}: malformed input sends nothing; schema and annotations are typed`, async () => {
    for (const input of [null, [], { ...valid[name], surprise: 1 }]) {
      const h = harness(name);
      assert.equal((await h.run(input)).error_kind, "invalid_input");
      assert.equal(h.requests.length, 0);
    }
    const d = harness(name).definition;
    assert.equal(d.kind, "page");
    assert.equal(d.tool.inputSchema.additionalProperties, false);
    assert.equal(d.tool.annotations.destructiveHint, name === "cancel_reservation");
    assert.ok(d.tool.description.length <= 400, "descriptions stay concise");
  });
}
for (const name of accountTools) {
  test(`${name}: wrong account stops after the identity read; logged out sends nothing`, async () => {
    const h = harness(name, { upcoming: [{ ...booked }], past: [{ ...booked, id: 3001 }] });
    assert.equal((await h.run({ ...valid[name], expected_account_ref: ref(1) })).error_kind, "wrong_account");
    assert.deepEqual(h.paths(), ["/2/user"]);
    const out = harness(name, { loggedOut: true });
    assert.equal((await out.run(valid[name])).error_kind, "login_required");
    assert.equal(out.requests.length, 0);
  });
}

test("get_booking_quote: exact slot, preview only, no tokens or card details returned", async () => {
  const h = harness("get_booking_quote", { fee: 25 });
  const out = await h.run(valid.get_booking_quote);
  assert.equal(out.status, "quote");
  assert.deepEqual(out.slot, { local_start: "2026-10-09T19:00", local_end: "2026-10-09T21:00", seating_type: "Dining Room" });
  assert.deepEqual([out.quote.total, out.quote.cancellation.fee, out.quote.cancellation.policy[0], out.quote.card_required], [0, 25, "Fabricated policy", true]);
  assert.deepEqual(h.paths(), ["/2/user", "/4/find", "/3/details:0"]);
  assert.equal((await harness("get_booking_quote", { fee: null }).run(valid.get_booking_quote)).quote.card_required, false);
  for (const [patch, kind] of [[{ local_start: "2026-10-09T19:15" }, "slot_unavailable"], [{ seating_type: "Bar", local_start: "2026-10-09T20:00" }, null]]) {
    const r = await harness("get_booking_quote").run({ ...valid.get_booking_quote, ...patch });
    assert.equal(r.error_kind ?? null, kind);
  }
  const twin = harness("get_booking_quote", { slots: [slotAt("19:00"), slotAt("19:00")] });
  assert.equal((await twin.run(valid.get_booking_quote)).error_kind, "ambiguous_slot");
});

test("book_reservation: quote, commit, one book with the default card, verified by the new reservation", async () => {
  const h = harness("book_reservation");
  const out = await h.run(valid.book_reservation);
  assert.equal(out.status, "booked");
  assert.deepEqual(out.reservation, { reservation_id: "5001", venue_id: 1001, venue_name: "Fabricated 1001", date: "2026-10-09", local_time: "19:00", party_size: 2, seating_type: "Dining Room" });
  assert.deepEqual(h.paths(), ["/2/user", "/3/user/reservations", "/4/find", "/3/details:0", "/3/details:1", "/3/book", "/3/user/reservations"]);
  const form = Object.fromEntries(new URLSearchParams(h.requests.find(r => r.path === "/3/book").body));
  assert.deepEqual(form, { book_token: "bt://private/rgs://private/19:00", venue_marketing_opt_in: "0", struct_payment_method: JSON.stringify({ id: 77 }) });
  const free = harness("book_reservation", { fee: null });
  await free.run(valid.book_reservation);
  assert.equal(new URLSearchParams(free.requests.find(r => r.path === "/3/book").body).has("struct_payment_method"), false, "no card when none is required");
});

test("book_reservation: confirm, stale total, duplicates, no card and missing slot never reach /3/book", async () => {
  const cases = [
    [{ confirm: false }, {}, "invalid_input"],
    [{ expected_total: 10 }, {}, "stale_state"],
    [{}, { upcoming: [{ ...booked, time: "21:00" }] }, null],
    [{}, { methods: [] }, "rejected"],
    [{ local_start: "2026-10-09T18:00" }, {}, "slot_unavailable"],
    [{}, { totalOverride: 99 }, "site_changed"]
  ];
  for (const [patch, opts, kind] of cases) {
    const h = harness("book_reservation", opts);
    const out = await h.run({ ...valid.book_reservation, ...patch });
    if (kind) assert.equal(out.error_kind, kind, JSON.stringify(patch));
    else assert.equal(out.status, "duplicate_suspected");
    assert.equal(h.requests.some(r => r.path === "/3/book"), false, JSON.stringify(opts));
  }
  const allowed = harness("book_reservation", { upcoming: [{ ...booked, time: "21:00" }] });
  assert.equal((await allowed.run({ ...valid.book_reservation, allow_duplicate: true })).status, "booked");
  const stale = harness("book_reservation");
  await stale.run({ ...valid.book_reservation, expected_total: 10 });
  assert.equal(stale.paths().includes("/3/details:1"), false, "a changed total stops before the slot is committed");
});

for (const [label, route, kind] of [
  ["4xx with no new reservation is rejected", ({ path }) => path === "/3/book" ? { status: 400, body: { message: "Card declined" } } : null, "rejected"],
  ["2xx with no new reservation is unknown", ({ path }) => path === "/3/book" ? { body: {} } : null, "outcome_unknown"],
  ["network failure after dispatch is unknown", ({ path }) => path === "/3/book" ? new Error("private") : null, "outcome_unknown"]
]) test(`book_reservation: ${label} and never retried`, async () => {
  const h = harness("book_reservation", { route });
  assert.equal((await h.run(valid.book_reservation)).error_kind, kind);
  assert.equal(h.requests.filter(r => r.path === "/3/book").length, 1);
});

test("book_reservation: a session switch after dispatch is unknown", async () => {
  const h = harness("book_reservation", { afterWrite: ({ window }) => { window.apiAuthToken = "changed"; } });
  assert.equal((await h.run(valid.book_reservation)).error_kind, "outcome_unknown");
});

test("change_reservation: moves the reservation through /3/change with its token and replace", async () => {
  const h = harness("change_reservation", { upcoming: [{ ...booked }] });
  const out = await h.run(valid.change_reservation);
  assert.deepEqual([out.status, out.previous.local_time, out.reservation.local_time], ["changed", "19:00", "19:30"]);
  const details = h.requests.filter(r => r.path === "/3/details");
  assert.ok(details.every(r => r.body.resy_token === "rr://private/4001"));
  const form = Object.fromEntries(new URLSearchParams(h.requests.find(r => r.path === "/3/change").body));
  assert.equal(form.replace, "1");
  assert.equal(form.resy_token, "rr://private/4001");
  for (const [patch, kind] of [[{ expected_date: "2026-10-10" }, "stale_state"], [{ reservation_id: "9" }, "not_found"], [{ venue_id: 1002 }, "stale_state"], [{ expected_total: 5 }, "stale_state"]]) {
    const x = harness("change_reservation", { upcoming: [{ ...booked }] });
    assert.equal((await x.run({ ...valid.change_reservation, ...patch })).error_kind, kind);
    assert.equal(x.requests.some(r => r.path === "/3/change"), false);
  }
});

test("cancel_reservation: before the fee cutoff cancels once and verifies removal", async () => {
  const h = harness("cancel_reservation", { upcoming: [{ ...booked }, { ...booked, id: 4002 }] });
  const out = await h.run(valid.cancel_reservation);
  assert.deepEqual([out.status, out.cancellation_fee], ["canceled", null]);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(h.requests.find(r => r.path === "/3/cancel").body)), { resy_token: "rr://private/4001" });
  assert.deepEqual(h.state.upcoming.map(r => r.id), [4002]);
});

test("cancel_reservation: a fee that applies now, or unknown terms, needs accept_cancellation_fee", async () => {
  for (const cancellation of [{ fee: { amount: 25, date_cut_off: "2026-09-29T00:00:00Z" } }, undefined]) {
    const h = harness("cancel_reservation", { upcoming: [{ ...booked, cancellation }] });
    assert.equal((await h.run(valid.cancel_reservation)).error_kind, "fee_applies");
    assert.equal(h.requests.some(r => r.path === "/3/cancel"), false);
    const ok = harness("cancel_reservation", { upcoming: [{ ...booked, cancellation }] });
    const out = await ok.run({ ...valid.cancel_reservation, accept_cancellation_fee: true });
    assert.equal(out.status, "canceled");
    assert.equal(out.cancellation_fee, cancellation ? 25 : null);
  }
  const mismatch = harness("cancel_reservation", { upcoming: [{ ...booked }] });
  assert.equal((await mismatch.run({ ...valid.cancel_reservation, expected_date: "2026-10-10" })).error_kind, "stale_state");
  const stuck = harness("cancel_reservation", { upcoming: [{ ...booked }], route: ({ path }) => path === "/3/cancel" ? { body: {} } : null });
  assert.equal((await stuck.run(valid.cancel_reservation)).error_kind, "outcome_unknown");
});

test("rate_reservation: rates once and verifies; already rated or expired sends nothing", async () => {
  const h = harness("rate_reservation", { past: [{ ...booked, id: 3001 }] });
  assert.equal((await h.run({ ...valid.rate_reservation, comments: " Lovely " })).status, "rated");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(h.requests.find(r => r.path === "/3/rate/reservation").body)), { rating: "4", resy_token: "rr://private/3001", comments: "Lovely" });
  for (const [rating, kind] of [[{ value: 5 }, "conflict"], [{ value: null, expired: true }, "rejected"]]) {
    const x = harness("rate_reservation", { past: [{ ...booked, id: 3001, rating }] });
    assert.equal((await x.run(valid.rate_reservation)).error_kind, kind);
    assert.equal(x.requests.some(r => r.path === "/3/rate/reservation"), false);
  }
  for (const patch of [{ rating: 0 }, { rating: 6 }, { rating: 4.5 }, { confirm: false }]) assert.equal((await harness("rate_reservation").run({ ...valid.rate_reservation, ...patch })).error_kind, "invalid_input");
});

test("get_share_link and copy_list: share URL from the slug; copies are new lists with a duplicate guard", async () => {
  const share = await harness("get_share_link").run(valid.get_share_link);
  assert.equal(share.share_url, "https://resy.com/shared/lists/SHARE-1");
  assert.equal((await harness("get_share_link").run({ ...valid.get_share_link, list_id: "NOPE" })).error_kind, "not_found");
  const dup = harness("copy_list");
  assert.equal((await dup.run({ ...valid.copy_list, allow_duplicate: false })).status, "duplicate_suspected");
  assert.equal(dup.writes().length, 0);
  const h = harness("copy_list");
  const out = await h.run(valid.copy_list);
  assert.deepEqual([out.status, out.name, out.venue_count], ["copied", "Weekend", 2]);
  assert.equal(h.writes().length, 1);
  assert.equal((await harness("copy_list").run({ ...valid.copy_list, list_slug: "MISSING" })).error_kind, "not_found");
});

test("get_venues: cards for known ids and the ids Resy did not return", async () => {
  const out = await harness("get_venues").run({ venue_ids: [1001, 9999] });
  assert.deepEqual(out.missing_venue_ids, [9999]);
  assert.equal(out.venues[0].url, "https://resy.com/cities/exampleton-xa/venues/fabricated-1001");
  for (const venue_ids of [[], [1, 1], Array.from({ length: 21 }, (_, i) => i + 1), ["1"]]) assert.equal((await harness("get_venues").run({ venue_ids })).error_kind, "invalid_input");
});

test("list_events: 1-based pages sent as Resy's offset; venue events page locally", async () => {
  const h = harness("list_events");
  const second = await h.run({ ...valid.list_events, page: 2, limit: 3 });
  assert.equal(h.requests[0].url.searchParams.get("offset"), "2");
  assert.deepEqual(second.events.map(e => e.name), ["Event 3", "Event 4", "Event 5"]);
  assert.equal(second.events[0].url, "https://resy.com/cities/exampleton-xa/venues/fabricated-1001/events/event-3");
  assert.deepEqual(second.events[0].price, { min: 40, max: 80, currency: "USD" });
  assert.equal((await harness("list_events").run({ venue_id: 1001 })).events[0].name, "Venue night");
  for (const input of [{}, { venue_id: 1, location: "xa" }, { location: "xa" }, { ...valid.list_events, page: 0 }]) assert.equal((await harness("list_events").run(input)).error_kind, "invalid_input");
});

test("list_collections and get_collection: Hit List is not a city collection; slots are sorted and capped at 6", async () => {
  assert.deepEqual((await harness("list_collections").run(valid.list_collections)).collections, [{ collection_id: 889, name: "Climbing", description: "Fabricated" }]);
  const h = harness("get_collection");
  const out = await h.run({ ...valid.get_collection, page: 3 });
  assert.equal(h.requests[0].url.searchParams.get("offset"), "3");
  assert.equal(out.venues.length, 1);
  assert.equal(out.venues[0].slot_count, 9);
  assert.deepEqual(out.venues[0].slots.map(s => s.local_start.slice(11)), ["10:00", "11:00", "12:00", "13:00", "14:00", "15:00"]);
});

// Live shape of a reservation's cancellation block, observed 2026-10-01.
const liveCancellation = applies => ({ allowed: true, date_credit_cut_off: null, date_refund_cut_off: "2026-10-09T22:00:00Z", fee: { amount: applies ? 50 : null, applies, date_cut_off: "2026-10-09T22:00:00Z", display: { amount: null } } });

test("cancel_reservation: Resy's fee.applies decides; cancellation.allowed false is refused", async () => {
  const free = harness("cancel_reservation", { upcoming: [{ ...booked, cancellation: liveCancellation(false) }] });
  assert.equal((await free.run(valid.cancel_reservation)).status, "canceled");
  const charged = harness("cancel_reservation", { upcoming: [{ ...booked, cancellation: liveCancellation(true) }] });
  const out = await charged.run(valid.cancel_reservation);
  assert.equal(out.error_kind, "fee_applies");
  assert.match(out.error_message, /of 50/);
  const locked = harness("cancel_reservation", { upcoming: [{ ...booked, cancellation: { ...liveCancellation(false), allowed: false } }] });
  assert.equal((await locked.run({ ...valid.cancel_reservation, accept_cancellation_fee: true })).error_kind, "rejected");
  assert.equal(charged.requests.some(r => r.path === "/3/cancel") || locked.requests.some(r => r.path === "/3/cancel"), false);
});

test("change_reservation: change.allowed false is refused before any details request", async () => {
  const h = harness("change_reservation", { upcoming: [{ ...booked, change: { allowed: false } }] });
  assert.equal((await h.run(valid.change_reservation)).error_kind, "rejected");
  assert.equal(h.requests.some(r => r.path === "/3/details" || r.path === "/3/change"), false);
});

test("book_reservation: Resy answers the committing details request with 201 or 200", async () => {
  for (const commitStatus of [200, 201]) assert.equal((await harness("book_reservation", { commitStatus }).run(valid.book_reservation)).status, "booked");
});

const reject = message => ({ status: 400, body: { message } });
for (const [name, path, opts] of [
  ["change_reservation", "/3/change", { upcoming: [{ ...booked }] }],
  ["cancel_reservation", "/3/cancel", { upcoming: [{ ...booked }] }],
  ["rate_reservation", "/3/rate/reservation", { past: [{ ...booked, id: 3001 }] }],
  ["copy_list", "/3/user/lists/SHARE-1/copy", {}]
]) for (const [label, response, kind] of [
  ["4xx with nothing changed is rejected", () => reject("Refused"), "rejected"],
  ["2xx with nothing changed is unknown", () => ({ body: {} }), "outcome_unknown"],
  ["network failure after dispatch is unknown", () => new Error("private"), "outcome_unknown"]
]) test(`${name}: ${label} and never retried`, async () => {
  const h = harness(name, { ...opts, route: r => r.path === path ? response() : null });
  assert.equal((await h.run(valid[name])).error_kind, kind);
  assert.equal(h.requests.filter(r => r.path === path).length, 1);
});

test("change_reservation: a seating-only change is verified by the new seating type", async () => {
  const input = { ...valid.change_reservation, local_start: "2026-10-09T19:00", seating_type: "Bar" };
  const h = harness("change_reservation", { upcoming: [{ ...booked }], slots: [slotAt("19:00", "Bar")] });
  const out = await h.run(input);
  assert.deepEqual([out.status, out.previous.seating_type, out.reservation.seating_type], ["changed", "Dining Room", "Bar"]);
  for (const response of [reject("Refused"), { body: {} }]) {
    const x = harness("change_reservation", { upcoming: [{ ...booked }], slots: [slotAt("19:00", "Bar")], route: ({ path }) => path === "/3/change" ? response : null });
    assert.equal((await x.run(input)).error_kind, response.status ? "rejected" : "outcome_unknown");
  }
});

test("change_reservation: the reservation's current slot sends nothing", async () => {
  const h = harness("change_reservation", { upcoming: [{ ...booked }] });
  assert.equal((await h.run({ ...valid.change_reservation, local_start: "2026-10-09T19:00" })).error_kind, "invalid_input");
  assert.equal(h.requests.some(r => r.path === "/3/details" || r.path === "/3/change"), false);
});

test("change_reservation: another reservation already at the target slot is not the moved one", async () => {
  const other = { ...booked, id: 4002, time: "19:30" };
  const noop = harness("change_reservation", { upcoming: [{ ...booked }, other], route: ({ path }) => path === "/3/change" ? { body: {} } : null });
  assert.equal((await noop.run(valid.change_reservation)).error_kind, "outcome_unknown");
  const moved = await harness("change_reservation", { upcoming: [{ ...booked }, { ...other }] }).run(valid.change_reservation);
  assert.deepEqual([moved.status, moved.reservation.reservation_id], ["changed", "4001"]);
});

test("book_reservation: an existing reservation at the booked slot does not count as the new one", async () => {
  const h = harness("book_reservation", { upcoming: [{ ...booked }], route: ({ path }) => path === "/3/book" ? reject("Refused") : null });
  assert.equal((await h.run({ ...valid.book_reservation, allow_duplicate: true })).error_kind, "rejected");
});

test("cancel_reservation: fee terms without Resy's flag or a readable amount need accept_cancellation_fee", async () => {
  for (const cancellation of [{ allowed: true }, { allowed: true, fee: { amount: "50.00", date_cut_off: "2026-09-29T00:00:00Z" } }]) {
    const h = harness("cancel_reservation", { upcoming: [{ ...booked, cancellation }] });
    assert.equal((await h.run(valid.cancel_reservation)).error_kind, "fee_applies");
    assert.equal(h.requests.some(r => r.path === "/3/cancel"), false);
  }
});

test("change_reservation: a new reservation beside the unchanged original is not a change", async () => {
  const h = harness("change_reservation", { upcoming: [{ ...booked }], route: ({ path, state }) => {
    if (path !== "/3/change") return null;
    state.upcoming.push({ ...booked, id: 4999, time: "19:30" });
    return { body: {} };
  } });
  assert.equal((await h.run(valid.change_reservation)).error_kind, "outcome_unknown");
});

test("rate_reservation: an unrated item that stays unrated after the write is unknown", async () => {
  const h = harness("rate_reservation", { past: [{ ...booked, id: 3001, rating: { value: null, expired: false } }], route: ({ path }) => path === "/3/rate/reservation" ? { body: {} } : null });
  assert.equal((await h.run(valid.rate_reservation)).error_kind, "outcome_unknown");
});
