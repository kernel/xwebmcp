import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { conforms, El, listedAt, loadTool, makeClock } from "./google-support.mjs";

const names = ["prepare_directions", "get_directions", "explore_destinations", "get_date_grid"];
const el = (tag, attrs = {}, children = []) => new El(tag, attrs, children);
const hide = e => { e.hiddenFlag = true; return e; };
function harness(name, { url, lang = "en", body = el("body"), signal = {}, clock = makeClock() } = {}) {
  const tool = loadTool(name);
  const document = {
    body, documentElement: { lang },
    querySelectorAll(selector) { return [...new Set(selector.split(", ").flatMap(s => body.querySelectorAll(s)))]; }
  };
  const execute = runInNewContext(`(${tool.execute.toString()})`, { location: new URL(url || "https://www.google.com/maps?hl=en"), document, Date: clock.Date, setTimeout: clock.setTimeout }, { timeout: 5000 });
  return { body, clock, tool, document, async run(input = {}) {
    const out = await execute(input, { signal });
    assert.ok(conforms(tool.tool.outputSchema, out), JSON.stringify(out));
    return JSON.parse(JSON.stringify(out));
  } };
}

const routeUrl = "https://www.google.com/maps/dir/Example+Town/Second+Town/?hl=en";
function routes({ count = 3, malformed = false } = {}) {
  const from = el("input", { "aria-label": "Starting point Example Town" }); from.value = "Example Town";
  const to = el("input", { "aria-label": "Destination Second Town" }); to.value = "Second Town";
  return el("body", {}, [from, to,
    el("div", { "data-travel_mode": "0" }, [el("button", { "aria-checked": "true", "data-tooltip": "Driving" })]),
    ...Array.from({ length: count }, (_, i) => el("div", { "data-trip-index": String(i), role: "button" }, [
      el("span", { role: "img", "aria-label": "Driving" }), el("div", { class: "MespJc" }, [
        el("h1", {}, [`via Example Road ${i}`]), el("div", { class: "Fk3sm" }, [malformed ? "" : "1 hr 15 min"]),
        el("div", { class: "ivN21e" }, ["60 miles"]), el("div", { class: "ue5qRc" }, ["Usual traffic"])
      ]), el("button", { "data-trip-index": String(i) }, ["Send to phone"])
    ]))
  ]);
}
function explore({ count = 3, origin = true } = {}) {
  const from = el("input", { "aria-label": origin ? "Where from? Example City ABC" : "Where from? " }); from.value = origin ? "Example City" : "";
  return el("body", {}, [from, el("div", { role: "combobox", "aria-labelledby": "trip" }, ["Round trip"]),
    el("div", { role: "combobox", "aria-labelledby": "cabin" }, ["Economy"]),
    el("button", { "aria-label": "2 passengers, change number of passengers." }),
    el("div", { role: "button" }, ["1-week trip in the next 6 months"]),
    el("div", { role: "progressbar", "aria-hidden": "true" }),
    ...Array.from({ length: count }, (_, i) => el("li", { role: "button", "data-code": `/m/example_${i}`, "data-rank": String(i) }, [
      el("h3", {}, [`Example Destination ${i}`]), el("div", { class: "xyc80b" }, ["Nov 7 – 14"]),
      el("div", { class: "sPjWyb" }, [el("span", { role: "text", "aria-label": "100 US dollars", "data-gs": "SESSION_TOKEN_DO_NOT_RETURN" }, ["$100"]), el("span", { class: "nx0jzf" }, ["Nonstop"]), el("span", { class: "Xq1DAb" }, ["2 hr"])]),
      el("span", { role: "text", "aria-label": "200 US dollars", "data-gs": "" }, ["$200"])
    ]))
  ]);
}
function grid({ count = 49, opened = false, oneWay = false, badLabel = false } = {}) {
  const cells = Array.from({ length: count }, (_, i) => el("div", { role: "button", "data-row": String(i), "data-col": "1", "aria-label": badLabel ? "changed label" : `$${100 + i}, ${i === 0 ? "cheapest price, " : ""}Nov 7 to Nov 14${i === 3 ? ", selected" : ""}` }, [`$${100 + i}`]));
  let cellClicks = 0, applyClicks = 0, openClicks = 0;
  cells.forEach(e => { e.handlers.click = () => cellClicks++; });
  const apply = el("button", {}, ["OK"]); apply.handlers.click = () => applyClicks++;
  const dialog = el("div", { role: "dialog", "aria-label": "Price insights" }, [el("button", { role: "tab", "aria-selected": "true" }, ["Dates"]), el("div", { "data-ow": String(oneWay) }, cells), apply]);
  if (!opened) hide(dialog);
  const opener = el("button", {}, ["Date grid"]); opener.handlers.click = () => { openClicks++; dialog.hiddenFlag = false; };
  const body = el("body", {}, [opener, dialog, el("div", { role: "button" }, ["USD"])]);
  return { body, cells, dialog, opener, clicks: () => ({ cellClicks, applyClicks, openClicks }) };
}

for (const name of names) {
  test(`${name}: precise product URL matching`, () => {
    const patterns = loadTool(name).match.url_patterns;
    const product = name === "explore_destinations" ? "/travel/explore" : name === "get_date_grid" ? "/travel/flights" : "/maps";
    for (const path of [product, product + "?hl=en", product + "/details"]) assert.ok(listedAt(patterns, "https://www.google.com" + path));
    for (const path of ["/", product + "x", "/finance", "/search?q=maps"]) assert.equal(listedAt(patterns, "https://www.google.com" + path), false);
    assert.equal(listedAt(patterns, "https://mail.google.com" + product), false);
    assert.equal(listedAt(patterns, "https://example.com" + product), false);
  });
  test(`${name}: malformed inputs fail before reading any site state`, async () => {
    const h = harness(name);
    Object.defineProperty(h.document, "body", { get() { throw new Error("site touched"); } });
    for (const input of [null, [], "x", { extra: "x" }, { limit: 0 }, { limit: 100 }, { limit: 1.2 }, { limit: null }]) assert.equal((await h.run(input)).status, "invalid_input");
  });
  test(`${name}: wrong page and canceled`, async () => {
    const input = name === "prepare_directions" ? { origin: "Example Town", destination: "Second Town" } : {};
    assert.equal((await harness(name, { url: "https://example.com/" }).run(input)).status, "wrong_page");
    assert.equal((await harness(name, { signal: { aborted: true } }).run(input)).status, "canceled");
  });
}

test("prepare_directions encodes exact endpoints without interacting or navigating", async () => {
  const h = harness("prepare_directions");
  const out = await h.run({ origin: "Example Street / Apt 1?x=#", destination: "第二都市" });
  assert.equal(out.status, "prepared");
  assert.equal(out.navigation_performed, false);
  const u = new URL(out.directions_url);
  assert.equal(decodeURIComponent(u.pathname.split("/")[3]), "Example Street / Apt 1?x=#");
  assert.equal(decodeURIComponent(u.pathname.split("/")[4]), "第二都市");
  assert.equal(u.origin, "https://www.google.com");
  assert.equal(u.search, "?hl=en");
  assert.equal(u.hash, "");
});
test("prepare_directions rejects equal, blank, invisible, oversized and control-character endpoints", async () => {
  for (const origin of ["Second Town", "  ", "\u200b", "a".repeat(201), "a\nb", "a\ud800"]) assert.equal((await harness("prepare_directions").run({ origin, destination: "Second Town" })).status, "invalid_input");
});

test("get_directions reads only loaded route cards, not child buttons, and caps results", async () => {
  const out = await harness("get_directions", { url: routeUrl, body: routes({ count: 15 }) }).run({ limit: 2 });
  assert.equal(out.status, "ok"); assert.equal(out.routes.length, 2); assert.equal(out.has_more, true);
  assert.deepEqual(out.routes[0], { mode: "Driving", summary: "via Example Road 0", duration_text: "1 hr 15 min", distance_text: "60 miles", note: "Usual traffic" });
  assert.equal(out.origin, "Example Town"); assert.equal(out.destination, "Second Town"); assert.equal(out.selected_mode, "Driving");
});
test("get_directions excludes hidden duplicates and fails on malformed route cards", async () => {
  const body = routes(); hide(body.children[3]);
  assert.equal((await harness("get_directions", { url: routeUrl, body }).run()).routes.length, 2);
  assert.equal((await harness("get_directions", { url: routeUrl, body: routes({ malformed: true }) }).run()).status, "site_changed");
});
test("get_directions rejects current location, pending endpoints, extra stops and input/URL mismatch", async () => {
  for (const origin of ["Your location", "", "Edited Town"]) {
    const body = routes(); body.children[0].value = origin;
    assert.equal((await harness("get_directions", { url: routeUrl, body }).run()).status, "not_ready");
  }
  const body = routes(); const stop = el("input", { "aria-label": "Destination Third Town" }); stop.value = "Third Town"; body.append(stop);
  assert.equal((await harness("get_directions", { url: routeUrl, body }).run()).status, "not_ready");
});
test("get_directions distinguishes missing/loading routes and explicit no results", async () => {
  for (const [message, status] of [["", "not_ready"], ["Could not calculate directions", "no_results"]]) {
    const body = routes({ count: 0 }); body.append(message);
    assert.equal((await harness("get_directions", { url: routeUrl, body }).run()).status, status);
  }
  const body = routes(); body.append(el("div", { role: "progressbar" }));
  assert.equal((await harness("get_directions", { url: routeUrl, body }).run()).status, "not_ready");
});

test("explore_destinations separates flight/hotel labels and returns no tracking payloads", async () => {
  const body = explore({ count: 50 }); hide(body.children.at(-1));
  const out = await harness("explore_destinations", { url: "https://www.google.com/travel/explore", body }).run({ limit: 40 });
  assert.equal(out.status, "ok"); assert.equal(out.destinations.length, 40); assert.equal(out.has_more, true);
  assert.equal(out.destinations[0].flight_price.display_text, "$100"); assert.equal(out.destinations[0].hotel_price.display_text, "$200");
  assert.equal(out.origin_text, "Example City ABC"); assert.equal(out.date_window_text, "1-week trip in the next 6 months");
  assert.equal(out.cabin_text, "Economy"); assert.equal(out.trip_type_text, "Round trip");
  assert.equal(JSON.stringify(out).includes("SESSION_TOKEN"), false);
});
test("explore_destinations requires resolved origin and closed pickers", async () => {
  assert.equal((await harness("explore_destinations", { url: "https://www.google.com/travel/explore", body: explore({ origin: false }) }).run()).status, "needs_origin");
  const body = explore(); body.children[0].value = "Edited City";
  assert.equal((await harness("explore_destinations", { url: "https://www.google.com/travel/explore", body }).run()).status, "not_ready");
  body.children[0].value = "Example City"; body.append(el("div", { role: "listbox" }));
  assert.equal((await harness("explore_destinations", { url: "https://www.google.com/travel/explore", body }).run()).status, "not_ready");
});
test("explore_destinations fails closed for malformed or empty cards", async () => {
  const body = explore(); body.children.at(-1).attrs["data-code"] = "https://example.com/session-token";
  assert.equal((await harness("explore_destinations", { url: "https://www.google.com/travel/explore", body }).run()).status, "site_changed");
  const empty = explore({ count: 0 }); empty.append("No destinations found");
  assert.equal((await harness("explore_destinations", { url: "https://www.google.com/travel/explore", body: empty }).run()).status, "no_results");
});

test("get_date_grid opens only the panel, reads labels, leaves dates and OK untouched", async () => {
  const g = grid();
  const h = harness("get_date_grid", { url: "https://www.google.com/travel/flights/search", body: g.body });
  const out = await h.run({ limit: 4 });
  assert.equal(out.status, "ok"); assert.equal(out.cells.length, 4); assert.equal(out.has_more, true);
  assert.equal(out.display_currency, "USD"); assert.equal(out.dates_applied, false);
  assert.deepEqual(out.cells[0], { departure_date_text: "Nov 7", return_date_text: "Nov 14", price_text: "$100", price_level: "cheapest", selected: false });
  assert.equal(out.cells[3].selected, true);
  assert.deepEqual(g.clicks(), { openClicks: 1, cellClicks: 0, applyClicks: 0 });
  await h.run(); assert.deepEqual(g.clicks(), { openClicks: 1, cellClicks: 0, applyClicks: 0 });
});
test("get_date_grid preserves explicit years and comma prices, excludes hidden cells", async () => {
  const g = grid({ opened: true, count: 3 }); hide(g.cells[1]);
  g.cells[0].attrs["aria-label"] = "$1,234, high price, Dec 31, 2026 to Jan 7, 2027";
  const out = await harness("get_date_grid", { url: "https://www.google.com/travel/flights/search", body: g.body }).run();
  assert.equal(out.status, "ok"); assert.equal(out.cells.length, 2);
  assert.equal(out.cells[0].price_text, "$1,234"); assert.equal(out.cells[0].return_date_text, "Jan 7, 2027");
});
test("get_date_grid refuses an unrelated dialog or a price graph without changing it", async () => {
  const g = grid(); g.body.append(el("div", { role: "dialog", "aria-label": "Share" }));
  assert.equal((await harness("get_date_grid", { url: "https://www.google.com/travel/flights/search", body: g.body }).run()).status, "dialog_open");
  assert.equal(g.clicks().openClicks, 0);
  const graph = grid({ opened: true }); graph.dialog.children[0].attrs["aria-selected"] = "false";
  assert.equal((await harness("get_date_grid", { url: "https://www.google.com/travel/flights/search", body: graph.body }).run()).status, "dialog_open");
});
test("get_date_grid detects one-way, missing controls, changed labels and timeout", async () => {
  for (const [settings, expected] of [[{ oneWay: true }, "unsupported_trip"], [{ badLabel: true }, "site_changed"], [{ count: 0 }, "timeout"]]) {
    const g = grid(settings);
    assert.equal((await harness("get_date_grid", { url: "https://www.google.com/travel/flights/search", body: g.body }).run()).status, expected);
    assert.equal(g.clicks().applyClicks, 0);
  }
  assert.equal((await harness("get_date_grid", { url: "https://www.google.com/travel/flights/search" }).run()).status, "not_ready");
});
test("get_date_grid cancellation after opening reports no applied dates", async () => {
  const signal = {}; const g = grid({ count: 0 });
  g.opener.handlers.click = () => { g.dialog.hiddenFlag = false; signal.aborted = true; };
  const out = await harness("get_date_grid", { url: "https://www.google.com/travel/flights/search", body: g.body, signal }).run();
  assert.equal(out.status, "canceled"); assert.equal(out.dates_applied, false); assert.equal(g.clicks().applyClicks, 0);
});
for (const name of names.filter(n => n !== "prepare_directions")) {
  test(`${name}: consent, challenge, rate limit and language failures are explicit`, async () => {
    assert.equal((await harness(name, { url: "https://consent.google.com/m" }).run()).status, "consent_required");
    assert.equal((await harness(name, { url: "https://www.google.com/sorry/index" }).run()).status, "blocked");
    const url = name === "get_directions" ? routeUrl : name === "explore_destinations" ? "https://www.google.com/travel/explore" : "https://www.google.com/travel/flights/search";
    assert.equal((await harness(name, { url, lang: "fr" }).run()).status, "unsupported_language");
    assert.equal((await harness(name, { url, body: el("body", {}, ["Too many requests"]) }).run()).status, "rate_limited");
  });
}
