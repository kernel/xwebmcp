import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { webcrypto, createHash } from "node:crypto";
import test from "node:test";

// A stateful fake of the Resy list and Notify endpoints. Identities, venues, lists and tokens are fabricated.
const names = ["list_lists", "get_list", "set_list_membership", "create_list", "delete_list", "create_notify", "remove_notify"];
const sources = Object.fromEntries(names.map(n => [n, readFileSync(new URL(`../domains/resy.com/${n}.js`, import.meta.url), "utf8")]));
const key = "fabricatedclientkey00000000000000";
const token = "fabricated-session-token";
const accountId = 12345;
const ref = id => "account_" + createHash("sha256").update("resy.com/account/" + id).digest("hex");
const account = ref(accountId);
const HIT = "00000000-0000-0000-0000-00000000HIT1";
const DATE = "Exampleton Dates";
const venueRow = id => ({ id: { resy: id }, name: "Fabricated " + id, url_slug: "fabricated-" + id, type: "Italian", price_range_id: 3, rater: [{ score: 4.5, total: 10 }], location: { url_slug: "exampleton-xa", neighborhood: "Old Quarter" }, user_venue_lists: ["private"] });
const windowOption = { service_type_id: 2, min_request_datetime: "2026-10-09 17:00:00", max_request_datetime: "2026-10-09 23:30:00", step_minutes: 30 };

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

function harness(name, o = {}) {
  const requests = [];
  const state = {
    lists: o.lists ?? [{ list_id: HIT, name: "My Hit List", is_legacy_hitlist: true, is_public: false, description: null }, { list_id: "LIST-1", name: DATE, is_legacy_hitlist: false, is_public: false, description: "Fabricated" }],
    members: o.members ?? { "LIST-1": [1001], [HIT]: [1002] },
    notifies: o.notifies ?? [],
    created: 0
  };
  const listRow = l => ({ ...l, url_slug: "SLUG-" + l.list_id, responsive_images: null, count: (state.members[l.list_id] || []).length });
  const notifyItem = n => ({ specs: { venue_id: n.venue_id, day: n.day, party_size: n.num_seats, service_type_id: n.service_type_id, time_preferred_start: n.time_preferred_start, time_preferred_end: n.time_preferred_end, notify_request_id: 7 }, results: { venues: [{ venue: { id: { resy: n.venue_id }, name: "Fabricated " + n.venue_id }, slots: [] }] } });
  const window = { location: { origin: o.origin ?? "https://resy.com" }, apiConfig: { Config: { apiKey: key } }, apiAuthToken: o.loggedOut ? undefined : token };
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : ["2026-09-30T01:00:00Z"])); } static now() { return Date.parse("2026-09-30T01:00:00Z"); } }
  const serve = (method, url, body) => {
    const path = url.pathname;
    let m;
    if (path === "/2/user") return { body: { id: accountId, em_address: "private@example.invalid" } };
    if (method === "GET" && path === "/3/user/lists") return { body: { results: { lists: state.lists.map(listRow) }, metadata: { total: state.lists.length, limit: 100, offset: 0 } } };
    if (method === "POST" && path === "/3/user/lists") { state.lists.push({ list_id: "NEW-" + ++state.created, name: body.name, description: body.description ?? null, is_legacy_hitlist: false, is_public: false }); return { status: 201, body: {} }; }
    if ((m = /^\/3\/user\/lists\/venue\/(\d+)$/.exec(path))) return { body: { results: { lists: state.lists.map(l => ({ ...listRow(l), is_venue_on_list: (state.members[l.list_id] || []).includes(Number(m[1])) })) }, metadata: { total: state.lists.length, limit: 100, offset: 0 } } };
    if ((m = /^\/3\/user\/lists\/([A-Za-z0-9-]+)$/.exec(path))) {
      const list = state.lists.find(l => l.list_id === m[1]);
      if (!list) return { status: 404, body: { message: "Not found" } };
      if (method === "DELETE") { state.lists = state.lists.filter(l => l !== list); delete state.members[list.list_id]; return { body: {} }; }
      const all = (state.members[list.list_id] || []).map(venueRow);
      const offset = Number(url.searchParams.get("offset")), limit = Number(url.searchParams.get("limit"));
      return { body: { list: listRow(list), results: { venues: all.slice(offset, offset + limit) }, metadata: { total: all.length, offset, limit }, created_by: { first_name: "Private" } } };
    }
    if ((m = /^\/3\/user\/venues\/(\d+)\/lists$/.exec(path))) {
      const venue = Number(m[1]);
      const ids = method === "POST" ? body.list_ids : [url.searchParams.get("list_ids")];
      for (const id of ids) {
        if (!state.lists.some(l => l.list_id === id)) return { status: 400, body: { message: "Sorry, something went wrong. Please try again." } };
        const set = new Set(state.members[id] || []);
        method === "POST" ? set.add(venue) : set.delete(venue);
        state.members[id] = [...set];
      }
      return { body: { list_ids: ids } };
    }
    if (method === "POST" && path === "/4/find") return { body: { query: { day: body.day, party_size: body.party_size }, results: { venues: [{ venue: { id: { resy: body.venue_id }, name: "Fabricated " + body.venue_id, notify_options: o.notifyOptions ?? [windowOption] }, slots: [] }] } } };
    if (method === "GET" && path === "/3/notify") return { body: { notify: state.notifies.map(notifyItem) } };
    if (method === "POST" && path === "/3/notify") { state.notifies.push(...JSON.parse(new URLSearchParams(body).get("struct_data")).notifies); return { status: 201, body: {} }; }
    if (method === "DELETE" && path === "/2/notify") {
      const q = Object.fromEntries(url.searchParams);
      state.notifies = state.notifies.filter(n => !(String(n.venue_id) === q.venue_id && n.day === q.day && String(n.num_seats) === q.num_seats && String(n.service_type_id) === q.service_type_id));
      return { status: 204, raw: "" };
    }
    return { status: 404, body: {} };
  };
  const ctx = { window, URL, URLSearchParams, Date: FixedDate, crypto: webcrypto, TextEncoder, Uint8Array, AbortController, setTimeout, clearTimeout, fetch: async (href, init) => {
    const url = new URL(href);
    assert.equal(url.origin, "https://api.resy.com");
    assert.equal(init.credentials, "omit");
    assert.equal(init.headers["x-resy-auth-token"], token);
    const body = init.body === undefined ? undefined : init.headers["Content-Type"] === "application/json" ? JSON.parse(init.body) : init.body;
    requests.push({ method: init.method, path: url.pathname, url, body, init });
    const forced = await o.route?.({ method: init.method, path: url.pathname, url, body, window, state });
    if (forced instanceof Error) throw forced;
    const r = forced ?? serve(init.method, url, body);
    if (init.method !== "GET" && o.afterWrite) o.afterWrite({ window, state, path: url.pathname });
    return { status: r.status ?? 200, text: async () => r.raw ?? JSON.stringify(r.body) };
  } };
  const [definition] = runInNewContext(`(${sources[name]})`, ctx);
  return { requests, state, window, definition, writes: () => requests.filter(r => r.method !== "GET" && r.path !== "/4/find"), run: async (input, context) => {
    const output = JSON.parse(JSON.stringify(await definition.execute(input, context)));
    assert.ok(conforms(definition.tool.outputSchema, output), JSON.stringify(output));
    const raw = JSON.stringify(output);
    for (const secret of [key, token, "private@example.invalid", "Private", "SLUG-"]) assert.equal(raw.includes(secret), false, secret);
    return output;
  } };
}

const notifyKey = { venue_id: 1001, date: "2026-10-09", party_size: 2, service_type_id: 2 };
const valid = {
  list_lists: { expected_account_ref: account },
  get_list: { expected_account_ref: account, list_id: "LIST-1" },
  set_list_membership: { expected_account_ref: account, list_id: "LIST-1", venue_id: 1003, on_list: true, expected_on_list: false },
  create_list: { expected_account_ref: account, name: "Weekend" },
  delete_list: { expected_account_ref: account, list_id: "LIST-1", expected_name: DATE, confirm: true },
  create_notify: { expected_account_ref: account, ...notifyKey, local_start_time: "19:00", local_end_time: "21:00" },
  remove_notify: { expected_account_ref: account, ...notifyKey, confirm: true }
};
const storedNotify = { venue_id: 1001, day: "2026-10-09", num_seats: 2, service_type_id: 2, time_preferred_start: "19:00:00", time_preferred_end: "21:00:00" };

for (const name of names) {
  test(`${name}: malformed input, wrong page and missing login send nothing`, async () => {
    for (const input of [null, [], { ...valid[name], surprise: true }, { ...valid[name], expected_account_ref: "bad" }]) {
      const h = harness(name);
      assert.equal((await h.run(input)).error_kind, "invalid_input");
      assert.equal(h.requests.length, 0);
    }
    const page = harness(name, { origin: "https://blog.resy.com" });
    assert.equal((await page.run(valid[name])).error_kind, "wrong_page");
    const out = harness(name, { loggedOut: true });
    assert.equal((await out.run(valid[name])).error_kind, "login_required");
    assert.equal(page.requests.length + out.requests.length, 0);
  });
  test(`${name}: wrong account stops after the identity read`, async () => {
    const h = harness(name);
    assert.equal((await h.run({ ...valid[name], expected_account_ref: ref(accountId + 1) })).error_kind, "wrong_account");
    assert.deepEqual(h.requests.map(r => r.path), ["/2/user"]);
  });
  test(`${name}: page kind and annotations match the action`, () => {
    const d = harness(name).definition;
    assert.equal(d.kind, "page");
    assert.deepEqual([...d.match.url_patterns], ["https://resy.com/*"]);
    assert.equal(d.tool.annotations.readOnlyHint, name === "list_lists" || name === "get_list");
    assert.equal(d.tool.annotations.destructiveHint, name === "delete_list" || name === "remove_notify");
  });
}

test("list_lists: lists with Hit List flag, counts and per-venue membership", async () => {
  const all = await harness("list_lists").run(valid.list_lists);
  assert.deepEqual(all.lists.map(l => [l.name, l.is_hit_list, l.venue_count, "contains_venue" in l]), [["My Hit List", true, 1, false], [DATE, false, 1, false]]);
  const h = harness("list_lists");
  const forVenue = await h.run({ ...valid.list_lists, venue_id: 1001 });
  assert.deepEqual(forVenue.lists.map(l => l.contains_venue), [false, true]);
  assert.equal(h.requests[1].path, "/3/user/lists/venue/1001");
  const odd = harness("list_lists", { route: ({ path }) => path === "/3/user/lists" ? { body: { results: { lists: [{ list_id: "x", name: "n" }] }, metadata: { total: 1 } } } : null });
  assert.equal((await odd.run(valid.list_lists)).error_kind, "site_changed");
});

test("get_list: one page with the requested offset and limit, no owner details", async () => {
  const h = harness("get_list", { members: { "LIST-1": [1001, 1002, 1003] } });
  const out = await h.run({ ...valid.get_list, offset: 1, limit: 1 });
  assert.equal(h.requests[1].url.search, "?offset=1&limit=1");
  assert.equal(out.total, 3);
  assert.deepEqual(out.venues, [{ venue_id: 1002, name: "Fabricated 1002", city_slug: "exampleton-xa", url_slug: "fabricated-1002", url: "https://resy.com/cities/exampleton-xa/venues/fabricated-1002", cuisine: "Italian", neighborhood: "Old Quarter", price_range: 3, rating: { average: 4.5, count: 10 } }]);
  assert.equal((await harness("get_list", { members: {} }).run(valid.get_list)).status, "no_results");
  assert.equal((await harness("get_list").run({ ...valid.get_list, list_id: "MISSING" })).error_kind, "not_found");
  for (const patch of [{ limit: 21 }, { offset: -1 }, { list_id: "../x" }]) assert.equal((await harness("get_list").run({ ...valid.get_list, ...patch })).error_kind, "invalid_input");
});

test("set_list_membership: add and restore leave exactly the initial memberships; repeats are no-ops", async () => {
  const h = harness("set_list_membership");
  const initial = structuredClone(h.state.members);
  assert.equal((await h.run(valid.set_list_membership)).status, "updated");
  assert.deepEqual(h.writes().map(r => [r.method, r.path, r.body]), [["POST", "/3/user/venues/1003/lists", { list_ids: ["LIST-1"] }]]);
  assert.equal((await h.run(valid.set_list_membership)).status, "unchanged");
  assert.equal((await h.run({ ...valid.set_list_membership, on_list: false, expected_on_list: true })).status, "updated");
  assert.equal(h.writes()[1].url.search, "?list_ids=LIST-1");
  assert.deepEqual(h.state.members, initial);
  assert.equal(h.writes().length, 2);
});

test("set_list_membership: stale state, Hit List and unknown list send nothing", async () => {
  for (const [patch, kind] of [[{ expected_on_list: true }, "stale_state"], [{ list_id: HIT }, "invalid_input"], [{ list_id: "MISSING" }, "not_found"]]) {
    const h = harness("set_list_membership");
    assert.equal((await h.run({ ...valid.set_list_membership, ...patch })).error_kind, kind);
    assert.equal(h.writes().length, 0);
  }
});

test("set_list_membership: a write that also moved the venue on another list is not reported as success", async () => {
  const h = harness("set_list_membership", { afterWrite: ({ state }) => { state.members[HIT] = [1003]; } });
  assert.equal((await h.run(valid.set_list_membership)).error_kind, "outcome_unknown");
  assert.equal(h.writes().length, 1);
});

for (const [label, route, kind] of [
  ["400 with nothing changed is rejected", ({ method }) => method === "POST" ? { status: 400, body: { message: "Sorry, something went wrong." } } : null, "rejected"],
  ["200 with nothing changed is unknown", ({ method }) => method === "POST" ? { body: {} } : null, "outcome_unknown"],
  ["network failure after dispatch is unknown", ({ method }) => method === "POST" ? new Error("private network detail") : null, "outcome_unknown"],
  ["500 after dispatch is unknown", ({ method }) => method === "POST" ? { status: 500, body: {} } : null, "outcome_unknown"]
]) test(`set_list_membership: ${label} and never retried`, async () => {
  const h = harness("set_list_membership", { route });
  const out = await h.run(valid.set_list_membership);
  assert.equal(out.error_kind, kind);
  assert.equal(out.error_message.includes("private network detail"), false);
  assert.equal(h.writes().length, 1);
});

test("set_list_membership: a session switch or cancellation after dispatch is unknown", async () => {
  const switched = harness("set_list_membership", { afterWrite: ({ window }) => { window.apiAuthToken = "changed"; } });
  assert.equal((await switched.run(valid.set_list_membership)).error_kind, "outcome_unknown");
  const abort = new AbortController();
  const canceled = harness("set_list_membership", { afterWrite: () => abort.abort() });
  assert.equal((await canceled.run(valid.set_list_membership, { signal: abort.signal })).error_kind, "outcome_unknown");
  assert.equal(switched.writes().length + canceled.writes().length, 2);
});

test("create_list: creates once and returns the new id; same name is duplicate_suspected unless allowed", async () => {
  const h = harness("create_list");
  const out = await h.run({ ...valid.create_list, name: "  Weekend   plans ", description: "Fabricated" });
  assert.deepEqual([out.status, out.list_id, out.name, out.is_public], ["created", "NEW-1", "Weekend plans", false]);
  assert.deepEqual(h.writes()[0].body, { name: "Weekend plans", description: "Fabricated" });
  const dup = harness("create_list");
  const again = await dup.run({ ...valid.create_list, name: DATE.toUpperCase() });
  assert.deepEqual([again.status, again.list_id], ["duplicate_suspected", "LIST-1"]);
  assert.equal(dup.writes().length, 0);
  const allowed = harness("create_list");
  assert.equal((await allowed.run({ ...valid.create_list, name: DATE, allow_duplicate: true })).list_id, "NEW-1");
});

test("create_list: no new list after the write is rejected or unknown, never success", async () => {
  const rejected = harness("create_list", { route: ({ method }) => method === "POST" ? { status: 400, body: { message: "Name too long" } } : null });
  assert.match((await rejected.run(valid.create_list)).error_message, /Name too long/);
  const silent = harness("create_list", { route: ({ method }) => method === "POST" ? { body: {} } : null });
  assert.equal((await silent.run(valid.create_list)).error_kind, "outcome_unknown");
  const paged = harness("create_list", { route: ({ path, method }) => method === "GET" && path === "/3/user/lists" ? { body: { results: { lists: [] }, metadata: { total: 101 } } } : null });
  assert.equal((await paged.run(valid.create_list)).error_kind, "site_changed");
  assert.equal(paged.writes().length, 0);
});

test("delete_list: requires confirm and the matching name, refuses the Hit List, verifies removal", async () => {
  for (const [patch, kind] of [[{ confirm: false }, "invalid_input"], [{ expected_name: "Other" }, "stale_state"], [{ list_id: HIT, expected_name: "My Hit List" }, "invalid_input"], [{ list_id: "MISSING" }, "not_found"]]) {
    const h = harness("delete_list");
    assert.equal((await h.run({ ...valid.delete_list, ...patch })).error_kind, kind);
    assert.equal(h.writes().length, 0);
  }
  const h = harness("delete_list");
  assert.deepEqual(await h.run({ ...valid.delete_list, expected_name: " exampleton  dates " }), { status: "deleted", account_ref: account, list_id: "LIST-1", name: DATE, venue_count: 1 });
  assert.deepEqual(h.writes().map(r => [r.method, r.path]), [["DELETE", "/3/user/lists/LIST-1"]]);
  assert.equal(h.state.lists.some(l => l.list_id === "LIST-1"), false);
  const kept = harness("delete_list", { route: ({ method }) => method === "DELETE" ? { body: {} } : null });
  assert.equal((await kept.run(valid.delete_list)).error_kind, "outcome_unknown");
});

test("create_notify: sends the site's form encoding once and verifies; identical repeat is unchanged", async () => {
  const h = harness("create_notify");
  assert.equal((await h.run(valid.create_notify)).status, "created");
  const [write] = h.writes();
  assert.equal(write.init.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.deepEqual(JSON.parse(new URLSearchParams(write.body).get("struct_data")), { notifies: [storedNotify] });
  assert.equal((await h.run(valid.create_notify)).status, "unchanged");
  assert.equal(h.writes().length, 1);
});

test("create_notify: a different window for the same request is a conflict and sends nothing", async () => {
  const h = harness("create_notify", { notifies: [storedNotify] });
  const out = await h.run({ ...valid.create_notify, local_start_time: "18:00" });
  assert.equal(out.error_kind, "conflict");
  assert.match(out.error_message, /19:00 to 21:00/);
  assert.equal(h.writes().length, 0);
});

for (const [label, patch, options] of [
  ["off the step", { local_start_time: "19:15" }],
  ["before the earliest time", { local_start_time: "16:30" }],
  ["after the latest time", { local_end_time: "23:59" }],
  ["end not after start", { local_end_time: "19:00" }],
  ["a service the venue does not offer", { service_type_id: 3 }],
  ["no Notify offered", {}, []],
  ["a past date", { date: "2026-09-01" }],
  ["a malformed time", { local_end_time: "9pm" }]
]) test(`create_notify: ${label} is invalid_input with nothing sent`, async () => {
  const h = harness("create_notify", { notifyOptions: options });
  assert.equal((await h.run({ ...valid.create_notify, ...patch })).error_kind, "invalid_input");
  assert.equal(h.writes().length, 0);
});

test("create_notify: a window past midnight uses the next calendar day of the service", async () => {
  const late = [{ service_type_id: 2, min_request_datetime: "2026-10-09 22:00:00", max_request_datetime: "2026-10-10 01:00:00", step_minutes: 30 }];
  const h = harness("create_notify", { notifyOptions: late });
  assert.equal((await h.run({ ...valid.create_notify, local_start_time: "23:30", local_end_time: "00:30" })).status, "created");
  assert.equal(h.state.notifies[0].day, "2026-10-09");
  assert.equal((await harness("create_notify", { notifyOptions: late }).run({ ...valid.create_notify, local_start_time: "00:30", local_end_time: "23:30" })).error_kind, "invalid_input");
});

test("create_notify: inventory for another venue or party is not trusted", async () => {
  const h = harness("create_notify", { route: ({ path, body }) => path === "/4/find" ? { body: { query: { day: body.day, party_size: 4 }, results: { venues: [{ venue: { id: { resy: 1001 }, notify_options: [windowOption] } }] } } } : null });
  assert.equal((await h.run(valid.create_notify)).error_kind, "site_changed");
  assert.equal(h.writes().length, 0);
});

test("remove_notify: requires confirm, absent sends nothing, removal is verified with the site's query", async () => {
  const unconfirmed = harness("remove_notify", { notifies: [storedNotify] });
  assert.equal((await unconfirmed.run({ ...valid.remove_notify, confirm: false })).error_kind, "invalid_input");
  const absent = harness("remove_notify");
  assert.equal((await absent.run(valid.remove_notify)).status, "absent");
  assert.equal(absent.writes().length + unconfirmed.writes().length, 0);
  const h = harness("remove_notify", { notifies: [storedNotify, { ...storedNotify, service_type_id: 3 }] });
  const out = await h.run(valid.remove_notify);
  assert.deepEqual([out.status, out.local_start_time, out.local_end_time], ["removed", "19:00", "21:00"]);
  assert.equal(h.writes()[0].url.search, "?venue_id=1001&day=2026-10-09&num_seats=2&service_type_id=2");
  assert.deepEqual(h.state.notifies.map(n => n.service_type_id), [3], "only the named Notify is removed");
  const stuck = harness("remove_notify", { notifies: [storedNotify], route: ({ method }) => method === "DELETE" ? { body: {} } : null });
  assert.equal((await stuck.run(valid.remove_notify)).error_kind, "outcome_unknown");
});
