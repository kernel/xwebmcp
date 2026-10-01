import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { webcrypto, createHash } from "node:crypto";
import test from "node:test";

const names = ["get_account_status", "list_reservations", "get_reservation", "list_notify_requests", "set_favorite"];
const sources = Object.fromEntries(names.map(n => [n, readFileSync(new URL(`../domains/resy.com/${n}.js`, import.meta.url), "utf8")]));
const key = "fabricatedclientkey00000000000000";
const token = "fabricated-session-token";
const accountId = 12345;
const ref = id => "account_" + createHash("sha256").update("resy.com/account/" + id).digest("hex");
const account = ref(accountId);
const expected = { expected_account_ref: account };
const favoriteInput = { ...expected, venue_id: 1001, city_slug: "exampleton-xa", url_slug: "fabricated-trattoria", favorite: true, expected_favorite: false };
const reservation = { reservation_id: 2001, venue: { id: 1001, currency: "USD" }, day: "2026-10-09", time_slot: "19:30:00", num_seats: 2, config: { type: "Dining Room" }, price: 25, cancellation_policy: ["<b>Cancel by the stated deadline.</b>"], resy_token: "rgs://private/fabricated", special_request: "private-request", attendee: { name: "private-name" }, payment_method: { token: "private-payment" } };
// Shaped like a live /3/notify item: the request in specs, next to a find-style block for its venue.
const notify = { specs: { venue_id: 1001, day: "2026-10-09", party_size: 2, service_type_id: 2, time_preferred_start: "18:00:00", time_preferred_end: "20:00:00", notify_request_id: 42 }, results: { venues: [{ venue: { id: { resy: 1001 }, name: "Fabricated Trattoria" }, slots: [], templates: {} }] }, modal_dismissed: false };

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

function harness(name, options = {}) {
  const requests = [];
  let saved = options.saved ?? false;
  const window = { location: { origin: options.origin ?? "https://resy.com" }, apiConfig: { Config: { apiKey: key } }, apiAuthToken: options.loggedOut ? undefined : token };
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : ["2026-09-30T01:00:00Z"])); } static now() { return Date.parse("2026-09-30T01:00:00Z"); } }
  const ctx = { window, URL, URLSearchParams, Date: FixedDate, crypto: options.crypto ?? webcrypto, TextEncoder, Uint8Array, AbortController, setTimeout, clearTimeout, fetch: async (url, init) => {
    const path = new URL(url).pathname;
    requests.push({ url, init, path });
    assert.equal(new URL(url).origin, "https://api.resy.com");
    assert.ok(["/2/user", "/3/venue", "/3/user/reservations", "/3/notify", "/3/user/favorites"].includes(path));
    assert.equal(init.credentials, "omit");
    assert.equal(init.headers.Authorization, `ResyAPI api_key="${key}"`);
    assert.equal(init.headers["x-resy-auth-token"], token);
    const forced = await options.route?.({ path, init, url, window, requests });
    if (forced) return { status: forced.status ?? 200, text: async () => forced.raw ?? JSON.stringify(forced.body) };
    let body;
    if (path === "/2/user") body = { id: accountId, em_address: "private@example.invalid", sous_auth_token: "private-token" };
    if (path === "/3/user/reservations") body = { reservations: options.empty ? [] : [reservation], venues: { 1001: { id: 1001, name: "Fabricated Trattoria" } }, metadata: { total: options.empty ? 0 : 1, limit: 10, offset: 1 } };
    if (path === "/3/notify") body = { notify: options.empty ? [] : [notify] };
    if (path === "/3/venue") body = { id: { resy: options.venueId ?? 1001 }, name: "Fabricated Trattoria", favorite: saved };
    if (path === "/3/user/favorites") {
      assert.equal(init.method, "POST");
      assert.equal(init.headers["Content-Type"], "application/x-www-form-urlencoded");
      assert.equal(new URLSearchParams(init.body).get("venue_id"), "1001");
      saved = new URLSearchParams(init.body).get("favorite") === "1";
      if (options.afterWrite) options.afterWrite({ window, init });
      body = {};
    }
    return { status: path === "/3/user/favorites" ? options.favoriteStatus ?? 200 : 200, text: async () => JSON.stringify(body) };
  } };
  const [definition] = runInNewContext(`(${sources[name]})`, ctx);
  return { requests, window, definition, state: () => saved, run: async (input, context) => {
    const output = JSON.parse(JSON.stringify(await definition.execute(input, context)));
    assert.ok(conforms(definition.tool.outputSchema, output), JSON.stringify(output));
    const raw = JSON.stringify(output);
    for (const secret of [key, token, "rgs://", "private-request", "private-payment", "private-name", "private-token", "private@example.invalid"]) assert.equal(raw.includes(secret), false, secret);
    return output;
  } };
}

for (const name of names) {
  test(`${name}: malformed input does not interact with site`, async () => {
    for (const input of [null, [], { surprise: true }, { confirmed: true }, { expected_account_ref: "bad" }]) {
      const h = harness(name);
      assert.equal((await h.run(input)).error_kind, "invalid_input");
      assert.equal(h.requests.length, 0);
    }
  });
  test(`${name}: page kind, bounded typed outputs, annotations`, () => {
    const d = harness(name).definition;
    assert.equal(d.kind, "page");
    assert.deepEqual([...d.match.url_patterns], ["https://resy.com/*"]);
    assert.equal(d.tool.annotations.readOnlyHint, name !== "set_favorite");
    assert.equal(d.tool.inputSchema.additionalProperties, false);
  });
}
const valid = n => n === "set_favorite" ? favoriteInput : n === "get_reservation" ? { ...expected, reservation_id: "2001" } : n === "get_account_status" ? {} : expected;
for (const name of names) {
  test(`${name}: wrong origin and pre-abort fail before fetch`, async () => {
    const h = harness(name, { origin: "https://blog.resy.com" });
    assert.equal((await h.run(valid(name))).error_kind, "wrong_page");
    assert.equal(h.requests.length, 0);
    const canceled = harness(name);
    assert.equal((await canceled.run(valid(name), { signal: AbortSignal.abort() })).error_kind, "canceled");
    assert.equal(canceled.requests.length, 0);
  });
  test(`${name}: missing login fails without requests`, async () => {
    const h = harness(name, { loggedOut: true });
    assert.equal((await h.run(valid(name))).error_kind, "login_required");
    assert.equal(h.requests.length, 0);
  });
}
test("account status only returns opaque reference", async () => {
  assert.deepEqual(await harness("get_account_status").run({}), { status: "ok", account_ref: account, authenticated: true });
});
for (const name of ["list_reservations", "get_reservation", "list_notify_requests", "set_favorite"]) test(`${name}: wrong account stops before account data or mutation`, async () => {
  const h = harness(name);
  assert.equal((await h.run({ ...valid(name), expected_account_ref: ref(accountId + 1) })).error_kind, "wrong_account");
  assert.deepEqual(h.requests.map(r => r.path), ["/2/user"]);
});
for (const name of ["list_reservations", "get_reservation", "list_notify_requests"]) test(`${name}: account switch during response withholds data`, async () => {
  const data = { list_reservations: "/3/user/reservations", get_reservation: "/3/user/reservations", list_notify_requests: "/3/notify" }[name];
  const h = harness(name, { route: ({ path, window }) => { if (path === data) window.apiAuthToken = "changed"; } });
  assert.equal((await h.run(valid(name))).error_kind, "wrong_account");
  assert.deepEqual(h.requests.map(r => r.path), ["/2/user", data]);
});
for (const name of ["list_reservations", "get_reservation", "list_notify_requests"]) test(`${name}: one identity read per call`, async () => {
  const h = harness(name);
  await h.run(valid(name));
  assert.deepEqual(h.requests.map(r => r.path), ["/2/user", name === "list_notify_requests" ? "/3/notify" : "/3/user/reservations"]);
});
test("account tools wait for the page's API configuration", async () => {
  const h = harness("get_account_status");
  const config = h.window.apiConfig;
  delete h.window.apiConfig;
  setTimeout(() => { h.window.apiConfig = config; }, 300);
  assert.equal((await h.run({})).status, "ok");
  const abort = new AbortController();
  const waiting = harness("get_account_status");
  delete waiting.window.apiConfig;
  setTimeout(() => abort.abort(), 100);
  assert.equal((await waiting.run({}, { signal: abort.signal })).error_kind, "canceled");
  assert.equal(waiting.requests.length, 0);
});
test("reservations: empty and populated pages, detail, raw policy and no automatic paging", async () => {
  const empty = await harness("list_reservations", { empty: true }).run(expected);
  assert.equal(empty.status, "no_results");
  const h = harness("list_reservations");
  const output = await h.run({ ...expected, type: "past", offset: 17, limit: 20 });
  assert.equal(output.status, "ok");
  assert.equal(output.reservations[0].reservation_id, "2001");
  assert.deepEqual(output.reservations[0].cancellation_policy, ["Cancel by the stated deadline."]);
  assert.equal(h.requests.filter(r => r.path === "/3/user/reservations").length, 1);
  assert.equal(new URL(h.requests[1].url).searchParams.get("offset"), "17");
  assert.equal((await harness("get_reservation").run({ ...expected, reservation_id: "2001" })).reservation.price, 25);
  assert.equal((await harness("get_reservation").run({ ...expected, reservation_id: "9999" })).error_kind, "not_found");
});
for (const patch of [{ reservation_id: "rgs://secret" }, { day: "2026-02-30" }, { num_seats: 0 }, { venue: { id: 9999 } }, { book_on_behalf: 1 }]) test(`reservation malformed item: ${JSON.stringify(patch)}`, async () => {
  const h = harness("list_reservations", { route: ({ path }) => path === "/3/user/reservations" ? { body: { reservations: [{ ...reservation, ...patch }], venues: { 1001: { name: "Fabricated Trattoria" } }, metadata: { total: 1 } } } : null });
  assert.equal((await h.run(expected)).error_kind, "site_changed");
});
test("notify: empty/populated and bounded 100 results", async () => {
  assert.equal((await harness("list_notify_requests", { empty: true }).run(expected)).status, "no_results");
  assert.deepEqual((await harness("list_notify_requests").run(expected)).requests[0], { venue_id: 1001, venue_name: "Fabricated Trattoria", date: "2026-10-09", party_size: 2, service_type_id: 2, local_start_time: "18:00", local_end_time: "20:00" });
  const flat = harness("list_notify_requests", { route: ({ path }) => path === "/3/notify" ? { body: { notify: [notify.specs] } } : null });
  assert.equal((await flat.run(expected)).error_kind, "site_changed", "an item without specs is not guessed at");
  const h = harness("list_notify_requests", { route: ({ path }) => path === "/3/notify" ? { body: { notify: Array(101).fill(notify) } } : null });
  const out = await h.run(expected);
  assert.equal(out.total, 101); assert.equal(out.requests.length, 100); assert.equal(out.truncated, true);
});
for (const status of [200, 201]) test(`favorite: HTTP ${status} add and restore verify state, duplicate is a no-op`, async () => {
  const h = harness("set_favorite", { favoriteStatus: status });
  const initial = h.state();
  assert.equal((await h.run(favoriteInput)).status, "updated");
  assert.equal(h.state(), true);
  assert.deepEqual(h.requests.map(r => r.path), ["/2/user", "/3/venue", "/3/user/favorites", "/3/venue"]);
  assert.equal((await h.run(favoriteInput)).status, "unchanged");
  assert.equal((await h.run({ ...favoriteInput, favorite: false, expected_favorite: true })).status, "updated");
  assert.equal(h.state(), initial);
  assert.equal(h.requests.filter(r => r.init.method === "POST").length, 2);
});
for (const status of [202, 204]) test(`favorite: HTTP ${status} does not establish a completed write`, async () => {
  const h = harness("set_favorite", { favoriteStatus: status });
  assert.equal((await h.run(favoriteInput)).error_kind, "outcome_unknown");
  assert.equal(h.requests.filter(r => r.init.method === "POST").length, 1);
});
test("favorite: HTTP 201 on a venue read is not accepted", async () => {
  const h = harness("set_favorite", { route: ({ path }) => path === "/3/venue" ? { status: 201, body: { id: { resy: 1001 }, name: "Fabricated Trattoria", favorite: false } } : null });
  assert.equal((await h.run(favoriteInput)).error_kind, "site_error");
  assert.equal(h.requests.some(r => r.init.method === "POST"), false);
});
test("favorite: wrong target and stale initial state never write", async () => {
  const h = harness("set_favorite", { venueId: 2002 });
  assert.equal((await h.run(favoriteInput)).error_kind, "site_changed");
  assert.equal(h.requests.some(r => r.init.method === "POST"), false);
  const stale = harness("set_favorite");
  assert.equal((await stale.run({ ...favoriteInput, expected_favorite: true })).error_kind, "stale_state");
  assert.equal(stale.requests.some(r => r.init.method === "POST"), false);
});
test("favorite: session switch on preflight prevents write", async () => {
  const h = harness("set_favorite", { route: ({ path, window }) => { if (path === "/3/venue") window.apiAuthToken = "changed"; } });
  assert.equal((await h.run(favoriteInput)).error_kind, "wrong_account");
  assert.equal(h.requests.some(r => r.init.method === "POST"), false);
});
for (const status of [200, 201]) for (const mode of ["session", "account", "cancel", "network", "verification", "http"]) test(`favorite: ${mode} after HTTP ${status} dispatch is unknown and never retried`, async () => {
  const abort = new AbortController();
  const h = harness("set_favorite", {
    favoriteStatus: status,
    afterWrite: ({ window }) => { if (mode === "session") window.apiAuthToken = "changed"; if (mode === "cancel") abort.abort(); },
    route: ({ path, init, requests, window }) => {
      if (path === "/3/user/favorites" && mode === "network") throw new Error("private error that must not leak");
      if (path === "/3/user/favorites" && mode === "http") return { status: 500, body: {} };
      if (path === "/3/venue" && mode === "verification" && requests.some(r => r.init.method === "POST")) return { status: 500, body: {} };
      if (path === "/3/venue" && mode === "account" && requests.some(r => r.init.method === "POST")) window.apiAuthToken = "changed";
    }
  });
  assert.equal((await h.run(favoriteInput, { signal: abort.signal })).error_kind, "outcome_unknown");
  assert.equal(h.requests.filter(r => r.init.method === "POST").length, 1);
});
for (const [http, kind] of [[401, "login_required"], [419, "login_required"], [403, "challenge"], [429, "rate_limited"], [500, "site_error"]]) test(`account request HTTP ${http}`, async () => {
  const h = harness("get_account_status", { route: () => ({ status: http, body: {} }) });
  assert.equal((await h.run({})).error_kind, kind);
});
for (const patch of [{ offset: 0 }, { offset: 10001 }, { limit: 0 }, { limit: 21 }, { type: "all" }, { type: null }, { offset: null }]) test(`reservation paging rejected before requests: ${JSON.stringify(patch)}`, async () => {
  const h = harness("list_reservations");
  assert.equal((await h.run({ ...expected, ...patch })).error_kind, "invalid_input");
  assert.equal(h.requests.length, 0);
});
test("reservation policy text omits signed links and booking handles", async () => {
  const h = harness("list_reservations", { route: ({ path }) => path === "/3/user/reservations" ? { body: { reservations: [{ ...reservation, cancellation_policy: ["Review https://example.invalid/policy?token=hidden and rgs://private/fabricated"] }], venues: { 1001: { name: "Fabricated Trattoria" } }, metadata: { total: 1 } } } : null });
  assert.deepEqual((await h.run(expected)).reservations[0].cancellation_policy, ["Review [link omitted] and [link omitted]"]);
});

