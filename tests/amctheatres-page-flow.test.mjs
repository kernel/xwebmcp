import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { Document } from "./etsy-dom.mjs";
import { conforms } from "./amctheatres-schema.mjs";

// amctheatres.com page-flow tools against fabricated pages that follow the live markup. Nothing here contacts the
// live site; theatres, movies, showtimes and orders are invented.
const ORIGIN = "https://www.amctheatres.com";
const NAMES = ["get_page_context", "navigate_to_page"];
const sources = Object.fromEntries(NAMES.map(n => [n, readFileSync(new URL(`../domains/amctheatres.com/${n}.js`, import.meta.url), "utf8")]));
const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
const plain = v => JSON.parse(JSON.stringify(v));

const HEADER_OUT = `<header><a href="/">AMC Theatres Home Page</a><a href="/movie-theatres" aria-label="Find a Theatre Quick Links">Find a Theatre</a><button>Sign In</button><button>Find a Theatre Near You</button></header>`;
const HEADER_IN = `<header><a href="/">AMC Theatres Home Page</a><a href="/movie-theatres">Find a Theatre</a><button>Example Member</button><button>AMC Example 12- Click to change your theatre.</button></header>`;

function page(html, { url = `${ORIGIN}/`, tools = ["get_page_context", "navigate_to_page"], hydrated = true, globals = {} } = {}) {
  const document = new Document(html);
  document.body = document.querySelector("body");
  if (hydrated) for (const el of document.querySelectorAll("button, input")) el.__reactProps$fabricated = {};
  if (tools) document.modelContext = { getTools: async () => tools.map(t => ({ name: `custom.amctheatres.com.${t}` })) };
  const u = new URL(url);
  const assigned = [];
  const timers = [];
  const location = { href: u.href, origin: u.origin, pathname: u.pathname, search: u.search, assign: to => assigned.push(to) };
  const context = {
    document, navigator: {}, URL, URLSearchParams, Date, Math, Number, String, Object,
    location, window: { location }, getComputedStyle: () => ({ visibility: "visible" }),
    MutationObserver: class { observe() {} disconnect() {} }, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, ...globals
  };
  context.globalThis = context;
  context.window.location = location;
  const run = async (name, input) => {
    const [definition] = runInNewContext(`(${sources[name]})`, context);
    const result = plain(await definition.execute(input));
    assert.ok(conforms(definition.tool.outputSchema, result), `${name} output violates its schema: ${JSON.stringify(result)}`);
    return result;
  };
  return { run, assigned, timers, context };
}
const ctx = (html, options, input = {}) => page(html, options).run("get_page_context", input);
const failed = (r, kind) => { assert.equal(r.status, "error", JSON.stringify(r)); assert.equal(r.error_kind, kind, r.error_message); return r; };

for (const name of NAMES) {
  test(`${name}: registry entry, kind and annotations match the source`, () => {
    const [definition] = runInNewContext(`(${sources[name]})`, {});
    const entry = registry.tools.find(t => t.domain === "amctheatres.com" && t.tool === name);
    assert.ok(entry);
    assert.equal(entry.kind, "page");
    assert.equal(definition.kind, "page");
    assert.equal(definition.tool.name, name);
    assert.equal(sources[name].trimEnd().endsWith(";"), false);
    // Neither tool sends a request: one reads the document, the other schedules a navigation.
    assert.doesNotMatch(sources[name], /fetch\(|XMLHttpRequest|graph\.amctheatres|\b(Buffer|require|process)\b/);
  });
}

test("get_page_context: showtimes page with slugs, date, current theatre and showtimes suggestions", async () => {
  const out = await ctx(`<html><head><title>AMC Example 12 Showtimes</title></head><body>${HEADER_IN}<main><section aria-label="Showtimes for Example Feature"></section></main></body></html>`,
    { url: `${ORIGIN}/movie-theatres/example-city/amc-example-12/showtimes?date=2026-10-03`, tools: ["get_showtimes", "navigate_to_page"] });
  assert.equal(out.page_type, "theatre_showtimes");
  assert.equal(out.market_slug, "example-city");
  assert.equal(out.theatre_slug, "amc-example-12");
  assert.equal(out.date, "2026-10-03");
  assert.equal(out.current_theatre, "AMC Example 12");
  assert.equal(out.signed_in, true);
  assert.equal(out.cart, null);
  assert.equal(out.blocked, null);
  assert.equal(out.unsettled, false);
  assert.deepEqual(out.available_tools, ["get_showtimes", "navigate_to_page"]);
  assert.ok(out.suggested_next_steps.some(s => s.includes('get_showtimes({ expected_date: "2026-10-03" })')));
  assert.ok(out.suggested_next_steps.some(s => s.includes('navigate_to_page({ url: "/showtimes/SHOWTIME_ID" })')));
});

test("get_page_context: seat page suggests the seat map and a price preview before any cart", async () => {
  const out = await ctx(`<html><head><title>Select Seats</title></head><body><header><a href="/">AMC</a></header><main><a href="/sign-in">Sign In or Join</a><div role="grid" aria-label="Seat Selection Map"></div></main></body></html>`,
    { url: `${ORIGIN}/showtimes/9001/seats`, tools: ["get_seat_map", "preview_tickets", "add_tickets_to_cart"] });
  assert.equal(out.page_type, "seats");
  assert.equal(out.showtime_id, 9001);
  assert.equal(out.signed_in, false);
  assert.equal(out.current_theatre, null);
  const steps = out.suggested_next_steps.join("\n");
  assert.match(steps, /get_seat_map\(\{ showtime_id: 9001, party_size: N \}\)/);
  assert.ok(steps.indexOf("preview_tickets") < steps.indexOf("add_tickets_to_cart"));
  assert.match(steps, /holds seats/);
});

test("get_page_context: an open cart reports its hold and hides the order id and token", async () => {
  const order = "00000000-0000-4000-8000-000000000000";
  const out = await ctx(`<html><head><title>Food and Drinks</title></head><body><header><span>6:41 left</span><a href="/">Close</a></header><main><aside role="region" aria-label="Order Details"></aside></main></body></html>`,
    { url: `${ORIGIN}/orders/${order}/food-and-drink`, tools: ["get_cart", "cancel_cart", "navigate_to_page"] });
  assert.equal(out.page_type, "cart");
  assert.deepEqual(out.cart, { step: "food-and-drink", expires_in_seconds: 401 });
  assert.equal(out.current_path, "/orders/{order}/food-and-drink");
  assert.doesNotMatch(JSON.stringify(out), new RegExp(order));
  assert.match(out.suggested_next_steps.join("\n"), /cancel_cart/);
  assert.match(out.suggested_next_steps.join("\n"), /leave_cart/);
  const edit = await ctx(`<html><body><main><div role="grid" aria-label="Ticket Selection"></div></main></body></html>`, { url: `${ORIGIN}/showtimes/9001/tickets?seats=F7&order-token=secret-token` });
  assert.equal(edit.page_type, "tickets");
  assert.deepEqual(edit.cart, { step: "edit_tickets", expires_in_seconds: null });
  assert.equal(edit.current_path, "/showtimes/9001/tickets?seats=F7");
  assert.doesNotMatch(JSON.stringify(edit), /secret-token/);
});

test("get_page_context: Cloudflare check and rate limit are reported as blocked with no tool suggestions", async () => {
  const challenge = await ctx(`<html><head><title>Just a moment...</title></head><body><p>Checking your browser</p></body></html>`, { url: `${ORIGIN}/showtimes/9001/seats` });
  assert.equal(challenge.blocked, "challenge");
  assert.equal(challenge.page_type, "blocked");
  assert.equal(challenge.suggested_next_steps.length, 1);
  assert.match(challenge.suggested_next_steps[0], /No tool bypasses it/);
  const limited = await ctx(`<html><head><title>amctheatres.com</title></head><body><h1>Error 1015</h1><p>You are being rate limited</p></body></html>`, { url: `${ORIGIN}/showtimes/9001/seats` });
  assert.equal(limited.blocked, "rate_limited");
});

test("get_page_context: page types, not found, signed out pages and search queries", async () => {
  const types = [
    [`${ORIGIN}/`, "home"], [`${ORIGIN}/movies?movie-list=coming-soon`, "movies"], [`${ORIGIN}/movies/example-feature-123`, "movie"],
    [`${ORIGIN}/movie-theatres`, "theatre_finder"], [`${ORIGIN}/movie-theatres/example-city`, "market"], [`${ORIGIN}/movie-theatres/example-city/amc-example-12`, "theatre"],
    [`${ORIGIN}/showtimes/9001`, "showtime"], [`${ORIGIN}/orders/x/confirmation`, "order"], [`${ORIGIN}/my-amc/profile`, "profile"],
    [`${ORIGIN}/my-amc/rewards`, "rewards"], [`${ORIGIN}/my-amc/tickets`, "account_other"], [`${ORIGIN}/gift-cards`, "other"]
  ];
  for (const [url, type] of types) assert.equal((await ctx(`<html><body>${HEADER_OUT}</body></html>`, { url })).page_type, type, url);
  const missing = await ctx(`<html><body>${HEADER_OUT}<main><h1>Error 404</h1><h2>You've gone off script</h2></main></body></html>`, { url: `${ORIGIN}/movies/wrong-slug-1` });
  assert.equal(missing.page_type, "not_found");
  assert.match(missing.suggested_next_steps.join("\n"), /no page at this address/);
  const profile = await ctx(`<html><body>${HEADER_OUT}</body></html>`, { url: `${ORIGIN}/my-amc/profile` });
  assert.equal(profile.signed_in, false);
  assert.match(profile.suggested_next_steps.join("\n"), /never ask for their password/);
  const finder = await ctx(`<html><body>${HEADER_OUT}<div aria-label="Theatre Search Results"><ul><li aria-live="polite">AMC Example 12</li></ul></div></body></html>`, { url: `${ORIGIN}/movie-theatres?q=Example%20City`, tools: ["search_theatres", "set_current_theatre", "navigate_to_page"] });
  assert.equal(finder.page_type, "theatre_finder");
  assert.equal(finder.search_query, "Example City");
  assert.equal(finder.unsettled, false);
  assert.match(finder.suggested_next_steps.join("\n"), /search_theatres/);
  const preview = await ctx(`<html><body>${HEADER_OUT}</body></html>`, { url: `${ORIGIN}/search?q=example`, tools: ["search_catalog", "navigate_to_page"] });
  assert.match(preview.suggested_next_steps.join("\n"), /navigate_to_page\(\{ url: "\/search\?filter=nowplaying%2Ccomingsoon&q=example" \}\)/);
});

test("get_page_context: loading states, a fresh navigation mark and tools that the page does not expose", async () => {
  const loading = await ctx(`<html><body>${HEADER_OUT}<main></main></body></html>`, { url: `${ORIGIN}/showtimes/9001/seats`, hydrated: false });
  assert.equal(loading.unsettled, true);
  assert.deepEqual(loading.unsettled_reasons, ["hydrating", "content_loading"]);
  assert.match(loading.suggested_next_steps[0], /still loading/);
  const href = `${ORIGIN}/`;
  const nav = await ctx(`<html><body>${HEADER_OUT}</body></html>`, { url: href, globals: { __xwebmcpAmcNavigation: { from: href, to: `${ORIGIN}/movies`, at: Date.now() } } });
  assert.ok(nav.unsettled_reasons.includes("navigating"));
  const stale = await ctx(`<html><body>${HEADER_OUT}</body></html>`, { url: href, globals: { __xwebmcpAmcNavigation: { from: href, to: `${ORIGIN}/movies`, at: Date.now() - 60000 } } });
  assert.ok(!stale.unsettled_reasons.includes("navigating"));
  const bare = await ctx(`<html><body>${HEADER_OUT}<main><div role="grid" aria-label="Seat Selection Map"></div></main></body></html>`, { url: `${ORIGIN}/showtimes/9001/seats`, tools: ["get_seat_map"] });
  const steps = bare.suggested_next_steps.join("\n");
  assert.match(steps, /get_seat_map/);
  assert.doesNotMatch(steps, /preview_tickets|add_tickets_to_cart/);
  const noModelContext = await ctx(`<html><body>${HEADER_OUT}</body></html>`, { tools: null });
  assert.equal(noModelContext.available_tools, null);
});

test("get_page_context: rejects bad input and other origins", async () => {
  failed(await ctx(`<html><body></body></html>`, {}, { wait_for_settled_seconds: 31 }), "invalid_input");
  failed(await ctx(`<html><body></body></html>`, {}, { other: 1 }), "invalid_input");
  failed(await ctx(`<html><body></body></html>`, { url: "https://example.com/" }), "wrong_page");
});

test("navigate_to_page schedules one same-origin navigation after returning and marks it for get_page_context", async () => {
  const p = page(`<html><body>${HEADER_OUT}</body></html>`, { url: `${ORIGIN}/` });
  const out = await p.run("navigate_to_page", { url: "/movie-theatres?q=10036" });
  assert.equal(out.status, "navigation_scheduled");
  assert.equal(out.to_url, `${ORIGIN}/movie-theatres?q=10036`);
  assert.equal(p.assigned.length, 0, "navigates only after returning");
  assert.equal(p.timers.length, 1);
  p.timers[0].fn();
  assert.deepEqual(p.assigned, [`${ORIGIN}/movie-theatres?q=10036`]);
  assert.equal(p.context.__xwebmcpAmcNavigation.from, `${ORIGIN}/`);
  assert.match(out.next_step, /get_page_context/);
});

test("navigate_to_page refuses other origins, order pages and unknown input without navigating", async () => {
  for (const url of ["https://example.com/", "//example.com/x", "/\\\\example.com", "movies", "", "/orders/x/food-and-drink", "/orders"]) {
    const p = page(`<html><body></body></html>`);
    failed(await p.run("navigate_to_page", { url }), "invalid_input");
    assert.equal(p.timers.length, 0, url);
  }
  for (const input of [{ url: "/", path: "/" }, { url: "/", leave_cart: "yes" }, null, []]) failed(await page(`<html><body></body></html>`).run("navigate_to_page", input), "invalid_input");
  failed(await page(`<html><body></body></html>`, { url: "https://example.com/" }).run("navigate_to_page", { url: "/" }), "wrong_page");
});

test("navigate_to_page will not leave an open cart unless asked, because leaving keeps the seats held", async () => {
  for (const url of [`${ORIGIN}/orders/x/food-and-drink`, `${ORIGIN}/orders/x/purchase`, `${ORIGIN}/showtimes/9001/tickets?order-token=x`]) {
    const p = page(`<html><body></body></html>`, { url });
    assert.match(failed(await p.run("navigate_to_page", { url: "/movies" }), "cart_open").error_message, /cancel_cart/);
    assert.equal(p.timers.length, 0);
    const leave = page(`<html><body></body></html>`, { url });
    assert.equal((await leave.run("navigate_to_page", { url: "/movies", leave_cart: true })).status, "navigation_scheduled");
  }
});

test("page-bound tools answer wrong_page with the navigate_to_page or preview_tickets call that opens their page", async () => {
  const cases = [
    ["get_favorite_theatres", {}, 'navigate_to_page({ url: "/my-amc/profile" })'],
    ["get_rewards", {}, 'navigate_to_page({ url: "/my-amc/rewards" })'],
    ["get_seat_map", { showtime_id: 9001 }, 'navigate_to_page({ url: "/showtimes/9001" })'],
    ["get_showtimes", {}, 'navigate_to_page({ url: "/movie-theatres/MARKET/THEATRE/showtimes?date=YYYY-MM-DD" })'],
    ["get_theatre", { theatre: "amc-example-12" }, 'navigate_to_page({ url: "/movie-theatres/MARKET/amc-example-12" })'],
    ["get_ticket_prices", { showtime_id: 9001 }, "preview_tickets for showtime 9001"],
    ["search_catalog", { query: "Example Feature" }, 'navigate_to_page({ url: "/search?filter=nowplaying%2Ccomingsoon&q=Example%20Feature" })'],
    ["search_catalog", {}, 'navigate_to_page({ url: "/search?filter=nowplaying%2Ccomingsoon&q=TITLE" })'],
    ["search_theatres", { query: "Example City" }, 'navigate_to_page({ url: "/movie-theatres?q=Example%20City" })'],
    ["set_current_theatre", { theatre: "amc-example-12" }, 'navigate_to_page({ url: "/movie-theatres?q=PLACE" })'],
    ["set_favorite_theatre", { theatre: "amc-example-12", favorite: true }, 'navigate_to_page({ url: "/movie-theatres/MARKET/amc-example-12" })']
  ];
  for (const [name, input, call] of cases) {
    const document = new Document(`<html><head><title>AMC</title></head><body>${HEADER_IN}<main></main></body></html>`);
    document.body = document.querySelector("body");
    const location = { href: `${ORIGIN}/gift-cards`, origin: ORIGIN, pathname: "/gift-cards", search: "" };
    const pageContext = { document, location, window: { location }, URLSearchParams, Date, getComputedStyle: () => ({ visibility: "visible" }), setTimeout };
    pageContext.globalThis = pageContext;
    const helpers = { js: async (fn, opts = {}) => plain(await runInNewContext(`(${fn.toString()})`, pageContext)(opts.arg)), waitMs: async () => {}, gotoUrl: async () => assert.fail(`${name} navigated`), click: async () => assert.fail(`${name} clicked`) };
    const source = readFileSync(new URL(`../domains/amctheatres.com/${name}.js`, import.meta.url), "utf8");
    const [definition] = runInNewContext(`(${source})`, helpers);
    const execute = definition.kind === "page" ? runInNewContext(`(${definition.execute.toString()})`, pageContext) : definition.execute;
    const result = plain(await execute(input, { signal: new AbortController().signal }));
    assert.ok(conforms(definition.tool.outputSchema, result), `${name} output violates its schema: ${JSON.stringify(result)}`);
    assert.ok(failed(result, "wrong_page").error_message.includes(call), `${name}: ${result.error_message}`);
  }
});
