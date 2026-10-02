import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webcrypto, createHash } from "node:crypto";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { Document } from "./etsy-dom.mjs";

// resy.com page-flow tools against fabricated pages and a fake API. Nothing here contacts the live site;
// venues, slugs, keys, tokens and credentials are fabricated.
const load = name => readFileSync(new URL(`../domains/resy.com/${name}.js`, import.meta.url), "utf8");
const plain = v => JSON.parse(JSON.stringify(v));
const KEY = "fabricatedclientkey00000000000000";
const TOKEN = "fabricated-session-token";

function pageContext(html, { url = "https://resy.com/cities/exampleton-xa", tools = [], token = TOKEN, globals = {} } = {}) {
  const document = new Document(html);
  document.modelContext = { getTools: async () => tools.map(t => ({ name: `custom.ct_x.${t}` })) };
  const proto = Object.getPrototypeOf(document.body);
  for (const attr of ["src", "title"]) if (!Object.getOwnPropertyDescriptor(proto, attr)) Object.defineProperty(proto, attr, { get() { return this.getAttribute(attr) || ""; }, configurable: true });
  proto.getBoundingClientRect = function () { return { height: Number(this.getAttribute("data-height") || 0) }; };
  const u = new URL(url);
  const context = { document, navigator: {}, URL, URLSearchParams, JSON, Number, Math, Date, String,
    location: { href: u.href, pathname: u.pathname, search: u.search },
    window: { apiAuthToken: token }, getComputedStyle: () => ({ visibility: "visible" }),
    MutationObserver: class { observe() {} disconnect() {} }, setTimeout: fn => { setImmediate(fn); return 0; }, ...globals };
  context.globalThis = context;
  const [tool] = runInNewContext(`(${load("get_page_context")})`, context);
  return tool.execute({}).then(plain);
}

test("get_page_context: venue page with slugs, date, seats, signed in, venue suggestions", async () => {
  const out = await pageContext(`<html><head><title>Book Fabricated Trattoria</title></head><body><main><h1>Fabricated Trattoria</h1><button class="ReservationButton">7:30 PM Dining Room</button></main></body></html>`,
    { url: "https://resy.com/cities/exampleton-xa/venues/fabricated_trattoria?date=2026-10-09&seats=2", tools: ["get_restaurant", "open_booking_dialog", "navigate_to_page"] });
  assert.equal(out.page_type, "venue");
  assert.equal(out.city_slug, "exampleton-xa");
  assert.equal(out.venue_slug, "fabricated_trattoria");
  assert.equal(out.venue_name, "Fabricated Trattoria");
  assert.equal(out.date, "2026-10-09");
  assert.equal(out.party_size, 2);
  assert.equal(out.signed_in, true);
  assert.equal(out.pending_choice, null);
  assert.equal(out.unsettled, false);
  assert.ok(out.suggested_next_steps.some(s => s.includes('get_restaurant({ city_slug: "exampleton-xa", url_slug: "fabricated_trattoria" })')));
  assert.ok(out.suggested_next_steps.some(s => s.includes("open_booking_dialog")));
});

test("get_page_context: open booking dialog is a pending choice that must not be confirmed", async () => {
  const out = await pageContext(`<html><body><h1>Fabricated</h1><div><iframe src="https://widgets.resy.com/#/reservation-details" title="Resy - Book Now" data-height="600"></iframe></div></body></html>`,
    { url: "https://resy.com/cities/exampleton-xa/venues/fab?date=2026-10-09&seats=2", tools: ["close_booking_dialog"] });
  assert.equal(out.pending_choice, "booking_dialog");
  assert.match(out.suggested_next_steps[0], /never press it/);
  assert.ok(out.suggested_next_steps.some(s => s.includes("close_booking_dialog")));
});

test("get_page_context: signed out, log-in window, lists, account pages, not found, navigating", async () => {
  const signedOut = await pageContext(`<html><body><header><button class="Button--login">Log in</button></header></body></html>`, { token: null, tools: ["search_restaurants"] });
  assert.equal(signedOut.signed_in, false);
  assert.equal(signedOut.page_type, "city_home");
  assert.ok(signedOut.suggested_next_steps.some(s => /Not signed in/.test(s)));
  const dialog = await pageContext(`<html><body><div role="dialog">Please log in: Mobile Number</div></body></html>`, { token: null });
  assert.equal(dialog.pending_choice, "login_dialog");
  const list = await pageContext(`<html><body></body></html>`, { url: "https://resy.com/cities/exampleton-xa/list/climbing?date=2026-10-10&seats=2", tools: ["get_collection"] });
  assert.equal(list.page_type, "algorithmic_list");
  assert.equal(list.list_name, "climbing");
  assert.ok(list.suggested_next_steps.some(s => s.includes('get_collection({ list: "climbing", city_slug: "exampleton-xa"')));
  assert.equal((await pageContext(`<html><body></body></html>`, { url: "https://resy.com/account/reservations-and-notify" })).page_type, "account_reservations");
  assert.equal((await pageContext(`<html><body><main>Sorry, but we can’t find that page.</main></body></html>`, { url: "https://resy.com/cities/exampleton-xa/venues/wrong" })).page_type, "not_found");
  const href = "https://resy.com/cities/exampleton-xa";
  const nav = await pageContext(`<html><body></body></html>`, { url: href, globals: { __xwebmcpResyNavigation: { from: href, to: href + "/search", at: Date.now() } } });
  assert.ok(nav.unsettled_reasons.includes("navigating"));
});

function navigate(url = "https://resy.com/cities/exampleton-xa") {
  const assigned = [], scheduled = [];
  const context = { URL, location: { href: url, assign: to => assigned.push(to) }, setTimeout: fn => { scheduled.push(fn); return 0; } };
  context.globalThis = context;
  const [tool] = runInNewContext(`(${load("navigate_to_page")})`, context);
  return { tool, context, run: input => tool.execute(input), assigned, scheduled };
}

test("navigate_to_page: schedules a same-origin navigation after returning and marks it", async () => {
  const n = navigate();
  const out = await n.run({ url: "/cities/exampleton-xa/venues/fab?date=2026-10-09&seats=2" });
  assert.equal(out.status, "navigation_scheduled");
  assert.equal(out.to_url, "https://resy.com/cities/exampleton-xa/venues/fab?date=2026-10-09&seats=2");
  assert.equal(n.assigned.length, 0, "must not navigate before returning");
  assert.equal(n.context.__xwebmcpResyNavigation.from, "https://resy.com/cities/exampleton-xa");
  n.scheduled[0]();
  assert.deepEqual(n.assigned, [out.to_url]);
  for (const path of ["/account/reservations-and-notify", "/list/climbing", "/venues/{url_slug}"]) assert.ok(n.tool.tool.description.includes(path));
});

for (const url of ["https://evil.example/", "//evil.example/x", "cities", "/\\evil.example", ""]) {
  test(`navigate_to_page: rejects ${JSON.stringify(url)} without navigating`, async () => {
    const n = navigate();
    assert.equal((await n.run({ url })).status, "error");
    assert.equal(n.scheduled.length, 0);
  });
}

function login(route, { token } = {}) {
  const requests = [], scheduled = [];
  const window = { apiConfig: { Config: { apiKey: KEY } }, apiAuthToken: token, location: { origin: "https://resy.com" } };
  const context = { window, URLSearchParams, JSON, AbortController, clearTimeout,
    location: { reload: () => scheduled.push("reload") },
    setTimeout: (fn, ms) => { if (ms === 200) scheduled.push(fn); return 0; },
    fetch: async (href, init) => { requests.push({ href, init }); const r = route(init); return { status: r.status, text: async () => JSON.stringify(r.body) }; } };
  const [tool] = runInNewContext(`(${load("login")})`, context);
  return { tool, window, requests, scheduled, run: input => tool.execute(input).then(plain) };
}
const creds = { email: "person@example.invalid", password: "fabricated-password" };

test("login: one form POST with the credentials; success schedules a reload and never returns the token", async () => {
  const l = login(() => ({ status: 200, body: { token: "fabricated-new-token", first_name: "Private" } }));
  const out = await l.run(creds);
  assert.equal(out.status, "signed_in_reload_scheduled");
  assert.equal(l.requests.length, 1);
  assert.equal(l.requests[0].href, "https://api.resy.com/4/auth/password");
  assert.equal(l.requests[0].init.method, "POST");
  assert.equal(l.requests[0].init.credentials, "include");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(l.requests[0].init.body)), creds);
  assert.equal(l.scheduled.length, 1, "reload is scheduled after returning");
  const raw = JSON.stringify(out);
  for (const secret of ["fabricated-new-token", "fabricated-password", "person@example.invalid", "Private"]) assert.equal(raw.includes(secret), false);
});

test("login: wrong password, rate limit, verification, already signed in, bad input; never retries", async () => {
  for (const [status, body, kind] of [[419, {}, "invalid_credentials"], [401, {}, "invalid_credentials"], [429, {}, "rate_limited"], [403, {}, "challenge"], [400, { message: "Verification code required" }, "verification_required"], [200, { mfa: true }, "verification_required"]]) {
    const l = login(() => ({ status, body }));
    const out = await l.run(creds);
    assert.equal(out.error_kind, kind, String(status));
    assert.equal(l.requests.length, 1);
    assert.equal(l.scheduled.length, 0);
  }
  const already = login(() => assert.fail("must not send"), { token: TOKEN });
  assert.equal((await already.run(creds)).status, "already_signed_in");
  for (const input of [{}, { email: "nope", password: "x" }, { email: creds.email, password: "" }]) {
    const l = login(() => assert.fail("must not send"));
    assert.equal((await l.run(input)).error_kind, "invalid_input");
  }
});

// --- open_booking_dialog / close_booking_dialog (cdp) with a fake venue page and booking frame -------------------

function bookingHarness({ url = "https://resy.com/cities/exampleton-xa/venues/fab?date=2026-10-09&seats=2", signedIn = true, buttons = ["7:00 PM Dining Room", "7:30 PM Dining Room", "7:30 PM Bar"], frame = "ready", alreadyOpen = false } = {}) {
  const state = { clicked: [], open: alreadyOpen, closed: false, evaluated: [] };
  const u = new URL(url);
  const pageArg = () => ({
    venue: /^\/cities\/[^/]+\/venues\/[^/]+$/.test(u.pathname), path: u.pathname,
    date: u.searchParams.get("date"), seats: u.searchParams.get("seats"), signedIn, open: state.open
  });
  const frameValue = () => frame === "ready" ? {
    ready: true, partial: true, error: null, venue: "Fabricated Trattoria", when: "Fri, Oct 9, 2026 7:30 PM", guests: "2 Guests, Dining Room",
    cardOnFile: true, addCard: false, cancellation: "Fee of $25.00 + tax per guest after Thu, Oct. 8.", other: [{ title: "About", text: "Fabricated" }],
    prices: ["Deposit $50.00"], button: "Reserve Now", enabled: true
  } : frame === "gone" ? { ready: false, partial: false, error: "Sorry, this reservation is no longer available.", venue: null } : null;
  const ctx = {
    js: async (fn, opts = {}) => {
      const src = String(fn);
      if (src.includes("ReservationButton")) {
        const { label, seating } = opts.arg;
        const norm = s => s.replace(/\s+/g, " ").trim();
        const hits = buttons.filter(b => b.startsWith(label) && (seating === null || norm(b.slice(label.length)).toLowerCase() === seating.toLowerCase()));
        if (hits.length === 1) { state.clicked.push(hits[0]); state.open = frame !== null; return { clicked: true, listed: buttons }; }
        return { clicked: false, ambiguous: hits.length > 1, loading: false, listed: buttons };
      }
      if (src.includes("apiAuthToken")) return pageArg();
      if (src.includes("widgets")) return state.open;
      throw new Error("unexpected js: " + src.slice(0, 80));
    },
    cdp: async (method, params) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "top", url: u.href }, childFrames: state.open ? [{ frame: { id: "w", url: "https://widgets.resy.com/", urlFragment: "#/reservation-details" } }] : [] } };
      if (method === "Page.createIsolatedWorld") { assert.equal(params.frameId, "w"); return { executionContextId: 7 }; }
      if (method === "Runtime.evaluate") {
        state.evaluated.push(params.expression);
        assert.equal(/Reserve Now"?\)?\.click|book\.click|\.click\(\)/.test(params.expression) && !params.expression.includes("WidgetNav__close"), false, "never clicks the final button");
        if (params.expression.includes("WidgetNav__close")) { state.open = false; state.closed = true; return { result: { value: true } }; }
        return { result: { value: frameValue() } };
      }
      throw new Error("unexpected cdp " + method);
    },
    waitMs: async () => {}
  };
  const run = (name, input) => runInNewContext(`(${load(name)})`, ctx)[0].execute(input).then(plain);
  return { state, run };
}

test("open_booking_dialog: clicks only the exact slot and reads the dialog; never presses Reserve Now", async () => {
  const h = bookingHarness();
  const out = await h.run("open_booking_dialog", { local_start: "2026-10-09T19:30", seating_type: "Dining Room", party_size: 2 });
  assert.equal(out.status, "dialog_open");
  assert.deepEqual(h.state.clicked, ["7:30 PM Dining Room"]);
  assert.equal(out.final_button_label, "Reserve Now");
  assert.equal(out.final_button_pressed, false);
  assert.equal(out.payment_card_on_file, true);
  assert.deepEqual(out.price_lines, ["Deposit $50.00"]);
  assert.match(out.cancellation_policy, /per guest/);
  assert.ok(!JSON.stringify(out).match(/ending in \d/), "no card digits");
  assert.equal((await h.run("close_booking_dialog", {})).status, "closed");
  assert.equal(h.state.closed, true);
  assert.equal((await h.run("close_booking_dialog", {})).status, "not_open");
});

test("open_booking_dialog: a missing or taken slot is reported, never substituted", async () => {
  const missing = bookingHarness();
  const out = await missing.run("open_booking_dialog", { local_start: "2026-10-09T20:00", seating_type: "Dining Room", party_size: 2 });
  assert.equal(out.status, "slot_unavailable");
  assert.equal(missing.state.clicked.length, 0);
  assert.ok(out.visible_slots.includes("7:30 PM Bar"));
  const gone = bookingHarness({ frame: "gone" });
  const g = await gone.run("open_booking_dialog", { local_start: "2026-10-09T19:00", seating_type: "Dining Room", party_size: 2 });
  assert.equal(g.status, "slot_unavailable");
  assert.match(g.message, /no longer available/);
  const twin = bookingHarness();
  assert.equal((await twin.run("open_booking_dialog", { local_start: "2026-10-09T19:30", seating_type: null, party_size: 2 })).error_kind, "invalid_input");
  assert.equal(twin.state.clicked.length, 0);
});

test("open_booking_dialog: wrong page, wrong date or seats, signed out, already open", async () => {
  const cases = [
    [{ url: "https://resy.com/cities/exampleton-xa" }, "wrong_page"],
    [{ url: "https://resy.com/cities/exampleton-xa/venues/fab?date=2026-10-10&seats=2" }, "wrong_page"],
    [{ url: "https://resy.com/cities/exampleton-xa/venues/fab?date=2026-10-09&seats=4" }, "wrong_page"],
    [{ signedIn: false }, "login_required"],
    [{ alreadyOpen: true }, "wrong_page"]
  ];
  for (const [opts, kind] of cases) {
    const h = bookingHarness(opts);
    const out = await h.run("open_booking_dialog", { local_start: "2026-10-09T19:30", seating_type: "Dining Room", party_size: 2 });
    assert.equal(out.error_kind, kind, JSON.stringify(opts));
    assert.equal(h.state.clicked.length, 0);
  }
  const wrongDate = await bookingHarness({ url: "https://resy.com/cities/exampleton-xa/venues/fab?date=2026-10-10&seats=2" }).run("open_booking_dialog", { local_start: "2026-10-09T19:30", seating_type: "Dining Room", party_size: 2 });
  assert.match(wrongDate.error_message, /navigate_to_page\(\{ url: "\/cities\/exampleton-xa\/venues\/fab\?date=2026-10-09&seats=2" \}\)/);
  for (const input of [{}, { local_start: "2026-10-09 19:30", party_size: 2 }, { local_start: "2026-10-09T19:30", party_size: 0 }, { local_start: "2026-10-09T19:30", party_size: 2, extra: 1 }]) {
    assert.equal((await bookingHarness().run("open_booking_dialog", input)).error_kind, "invalid_input");
  }
});

// --- list_reservations date filter and search_restaurants neighborhood / price ----------------------------------

const ACCOUNT_ID = 4242;
const accountRef = "account_" + createHash("sha256").update("resy.com/account/" + ACCOUNT_ID).digest("hex");
function api(name, serve) {
  const requests = [];
  const window = { location: { origin: "https://resy.com" }, apiConfig: { Config: { apiKey: KEY } }, apiAuthToken: TOKEN };
  const ctx = { window, URL, URLSearchParams, crypto: webcrypto, TextEncoder, Uint8Array, AbortController, setTimeout, clearTimeout, Symbol,
    fetch: async (href, init) => {
      const url = new URL(href);
      const body = init.body && init.headers?.["Content-Type"] === "application/json" ? JSON.parse(init.body) : init.body;
      requests.push({ url, body });
      const r = serve(url, body) ?? { status: 404, body: {} };
      return { status: r.status ?? 200, text: async () => JSON.stringify(r.body) };
    } };
  const [tool] = runInNewContext(`(${load(name)})`, ctx);
  return { requests, run: input => tool.execute(input).then(plain) };
}

test("list_reservations: start_date/end_date scan pages newest first and stop past the range", async () => {
  const days = Array.from({ length: 45 }, (_, i) => new Date(Date.UTC(2026, 8, 29) - i * 5 * 86400000).toISOString().slice(0, 10));
  const h = api("list_reservations", url => {
    if (url.pathname === "/2/user") return { body: { id: ACCOUNT_ID } };
    if (url.pathname === "/3/user/reservations") {
      const off = Number(url.searchParams.get("offset")), lim = Number(url.searchParams.get("limit"));
      const slice = days.slice((off - 1) * lim, off * lim);
      return { body: { reservations: slice.map((d, i) => ({ reservation_id: 9000 + off * 100 + i, venue: { id: 77, currency: "USD" }, day: d, time_slot: "19:00:00", num_seats: 2, config: { type: "Dining Room" } })), venues: { 77: { name: "Fabricated Bistro" } }, metadata: { total: days.length } } };
    }
  });
  const out = await h.run({ expected_account_ref: accountRef, type: "past", start_date: "2026-08-01", end_date: "2026-08-31" });
  assert.equal(out.status, "ok");
  assert.ok(out.reservations.every(r => r.date >= "2026-08-01" && r.date <= "2026-08-31"));
  assert.equal(out.reservations.length, 6);
  assert.equal(out.date_filter.scan_complete, true);
  assert.equal(h.requests.filter(r => r.url.pathname === "/3/user/reservations").length, 1, "stops once a page passes start_date");
  for (const input of [{ expected_account_ref: accountRef, start_date: "2026-09-31" }, { expected_account_ref: accountRef, start_date: "2026-09-02", end_date: "2026-09-01" }, { expected_account_ref: accountRef, start_date: "2026-09-01", offset: 2 }]) {
    assert.equal((await h.run(input)).error_kind, "invalid_input");
  }
});

test("search_restaurants: neighborhood is sent server-side with a title-cased retry; max_price_range filters the page", async () => {
  const hit = (id, price) => ({ id: { resy: id }, name: "Fabricated " + id, url_slug: "fab-" + id, location: { url_slug: "exampleton-xa" }, price_range_id: price, neighborhood: "Old Quarter", cuisine: ["Italian"], _geoloc: { lat: 40, lng: -74 } });
  const h = api("search_restaurants", (url, body) => {
    if (url.pathname === "/3/location/config") return { body: [{ code: "xa", url_slug: "exampleton-xa", name: "Exampleton", show_on_web: 1, map_center: { latitude: 40, longitude: -74 } }] };
    if (url.pathname === "/3/venuesearch/search") return { body: { search: { hits: body.venue_filter?.neighborhood === "Old Quarter" ? [hit(1, 2), hit(2, 4), hit(3, 1)] : [] }, meta: { total: 3 } } };
  });
  const out = await h.run({ location: "exampleton-xa", neighborhood: "old quarter", max_price_range: 2 });
  assert.equal(out.status, "ok");
  assert.equal(out.query.neighborhood, "Old Quarter");
  assert.deepEqual(out.venues.map(v => v.venue_id), [1, 3]);
  assert.ok(out.warnings.some(w => /above max_price_range/.test(w)));
  const searches = h.requests.filter(r => r.url.pathname === "/3/venuesearch/search");
  assert.deepEqual(searches.map(r => r.body.venue_filter.neighborhood), ["old quarter", "Old Quarter"]);
  assert.equal((await h.run({ neighborhood: "Old Quarter", query: "x" })).error_kind, "invalid_input");
  assert.equal((await h.run({ location: "xa", max_price_range: 5 })).error_kind, "invalid_input");
});
