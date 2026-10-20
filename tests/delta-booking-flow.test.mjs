import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { Document } from "./etsy-dom.mjs";

const load = name => readFileSync(new URL(`../domains/delta.com/${name}.js`, import.meta.url), "utf8");
const plain = v => JSON.parse(JSON.stringify(v));

// Runs one Delta page tool against a fabricated document. Clicks are routed to `onClick`.
function run(name, html, input = {}, { url = "https://www.delta.com/", tools = [], onClick = () => {}, readyState = "complete" } = {}) {
  const document = new Document(html);
  document.readyState = readyState;
  document.modelContext = { getTools: async () => tools.map(t => ({ name: `custom.ct_x.${t}` })) };
  const scheduled = [];
  const u = new URL(url);
  // etsy-dom elements have no click(); give every element one that reports to onClick.
  const proto = Object.getPrototypeOf(document.body);
  proto.click = function () { onClick(this, document); };
  if (!("checked" in proto)) Object.defineProperty(proto, "checked", { get() { return this.hasAttribute("checked"); }, set(v) { v ? this.setAttribute("checked", "") : this.removeAttribute("checked"); }, configurable: true });
  const context = {
    document, navigator: {}, URL, URLSearchParams, JSON, Number, Math, Date,
    location: { href: u.href, hostname: u.hostname, pathname: u.pathname, search: u.search },
    getComputedStyle: () => ({ visibility: "visible" }),
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout: (fn, ms) => { if (ms === 100) { scheduled.push(fn); return 0; } setImmediate(fn); return 0; }
  };
  const [tool] = runInNewContext(`(${load(name)})`, context);
  return tool.execute(input).then(out => ({ out: plain(out), scheduled, document, tool }));
}

// --- fixtures -------------------------------------------------------------------------------
const fareCell = (row, code, price) => `<idp-fare-cell-desktop><div id="grid-row-${row}-fare-cell-desktop-${code}" class="fare-cell-desktop fare-cell-desktop-${code} available">
  <a id="#${code}-0-row-${row}" role="button">Delta Main</a>${price ? `<div tabindex="0"><span>$${price}</span> One-Way</div>` : "<span>Sold Out</span>"}</div></idp-fare-cell-desktop>`;
const drawerHtml = `<div id="idp-upsell-drawer-id"><h2>Select an Experience to Continue</h2>
  <div class="w-full"><h3>Main Basic</h3><p>All the Essentials</p><p>Cancel for partial eCredit, changes allowed for a fee<sup>1</sup></p><p>Board in Zone 8<sup>2</sup></p>
    <a>View All Restrictions</a><label for="restrictions">Accept Restrictions</label><input type="checkbox" id="restrictions"><span>One-Way</span><span>$399</span><p>3 left at this price</p>
    <button id="drawer-select-cta-BMAIN" aria-label="Select Main <strong>Basic</strong>">Select</button></div>
  <div class="w-full"><span>Most Popular</span><h3>Main Classic</h3><p>More Freedom and Flexibility</p><p>Board in Zone 6 or 7<sup>11</sup></p><span>One-Way</span><span>$464</span>
    <button id="drawer-select-cta-CMAIN" aria-label="Select Main<strong> Classic</strong>">Select</button></div>
</div>`;
const results = (drawer = false) => `<html><body><idp-search-results>
  <div id="flight-results-grid-5"><idp-mach-core-flight-card><a data-testid="flight-card-header-segment-link-0">DL2441</a><a data-testid="flight-card-header-segment-link-1">DL693</a></idp-mach-core-flight-card>
  ${fareCell(5, "BMAIN", 399)}${fareCell(5, "BDCP", null)}${drawer ? drawerHtml : ""}</div>
</idp-search-results></body></html>`;
const resultsUrl = "https://www.delta.com/flightsearch/search-results?cacheKeySuffix=k";
const openDrawer = (el, doc) => {
  if (el.getAttribute("tabindex") === "0") {
    const row = doc.getElementById("flight-results-grid-5");
    const holder = new Document(drawerHtml).body.children[0] ?? new Document(drawerHtml).root.children[0];
    row.childNodes.push(holder); holder.parentNode = row;
    el.parentElement.setAttribute("class", el.parentElement.getAttribute("class") + " is-selected");
  }
};

// --- select_fare ------------------------------------------------------------------------------
test("select_fare: opens the drawer and returns experiences with restrictions and consent flag", async () => {
  const clicks = [];
  const { out } = await run("select_fare", results(), { result_index: 5, brand_code: "BMAIN", expected_flight_numbers: ["DL 2441", "DL 693"] },
    { url: resultsUrl, onClick: (el, doc) => { clicks.push(el.getAttribute("tabindex") ?? el.tagName); openDrawer(el, doc); } });
  assert.deepEqual(clicks, ["0"], "clicks the price block, not the brand link that opens Details");
  assert.equal(out.status, "experience_choice_required");
  assert.deepEqual(out.flight_numbers, ["DL 2441", "DL 693"]);
  const [basic, classic] = out.experiences;
  assert.equal(basic.code, "BMAIN");
  assert.equal(basic.name, "Main Basic");
  assert.equal(basic.tagline, "All the Essentials");
  assert.equal(basic.amount, 399);
  assert.equal(basic.seats_left, 3);
  assert.deepEqual(basic.details, ["Cancel for partial eCredit, changes allowed for a fee", "Board in Zone 8"], "footnote <sup> removed");
  assert.equal(basic.requires_accepting_restrictions, true);
  assert.equal(classic.requires_accepting_restrictions, false);
  assert.deepEqual(classic.details, ["Board in Zone 6 or 7"]);
});

test("select_fare: refuses when the row shows different flights, a sold-out fare, or a missing row", async () => {
  let clicked = 0;
  const onClick = () => { clicked++; };
  assert.equal((await run("select_fare", results(), { result_index: 5, brand_code: "BMAIN", expected_flight_numbers: ["DL 1"] }, { url: resultsUrl, onClick })).out.status, "row_changed");
  assert.equal((await run("select_fare", results(), { result_index: 5, brand_code: "BDCP" }, { url: resultsUrl, onClick })).out.status, "not_available");
  assert.equal((await run("select_fare", results(), { result_index: 9, brand_code: "BMAIN" }, { url: resultsUrl, onClick })).out.status, "row_changed");
  assert.equal(clicked, 0);
});

// --- select_fare_experience -------------------------------------------------------------------
test("select_fare_experience: Basic without consent is refused and nothing is ticked or clicked", async () => {
  const clicks = [];
  const { out, scheduled, document } = await run("select_fare_experience", results(true), { code: "BMAIN" }, { url: resultsUrl, onClick: el => clicks.push(el.id) });
  assert.equal(out.status, "consent_required");
  assert.deepEqual(clicks, []);
  assert.equal(scheduled.length, 0);
  assert.equal(document.getElementById("restrictions").checked, false);
});

test("select_fare_experience: Basic with consent ticks Accept Restrictions, then schedules Select after settling", async () => {
  const clicks = [];
  const { out, scheduled } = await run("select_fare_experience", results(true), { code: "BMAIN", accept_restrictions: true },
    { url: resultsUrl, onClick: (el, doc) => { clicks.push(el.id || el.tagName); if (el.tagName === "LABEL") doc.getElementById("restrictions").checked = true; } });
  assert.equal(out.status, "navigation_scheduled");
  assert.equal(out.name, "Main Basic");
  assert.equal(out.restrictions_accepted, true);
  assert.deepEqual(clicks, ["LABEL"], "Select is not clicked before the tool settles");
  scheduled[0]();
  assert.deepEqual(clicks, ["LABEL", "drawer-select-cta-BMAIN"]);
});

test("select_fare_experience: Classic needs no consent; unknown code and closed drawer are explicit errors", async () => {
  const { out, scheduled } = await run("select_fare_experience", results(true), { code: "CMAIN" }, { url: resultsUrl });
  assert.equal(out.status, "navigation_scheduled");
  assert.equal(out.price_display, "$464");
  assert.equal(out.restrictions_accepted, false);
  assert.equal(scheduled.length, 1);
  assert.match((await run("select_fare_experience", results(true), { code: "EFIRST" }, { url: resultsUrl })).out.error_message, /offers BMAIN, CMAIN/);
  assert.equal((await run("select_fare_experience", results(false), { code: "CMAIN" }, { url: resultsUrl })).out.status, "no_drawer");
});

// --- get_trip_summary -------------------------------------------------------------------------
const summaryHtml = `<html><body>
  <div class="summary"><div class="summary-text summary-text__flight-type">One Way</div>
    <div class="summary-text summary-text__flight-id id"><span class="hide">Flight number </span>DL2441, DL693</div>
    <div class="summary-text flight-origin-code"><span class="hide">Departure Airport code </span>CVG</div>
    <div class="summary-text flight-depart-code"><span class="hide">Arrival Airport code </span>SFO</div>
    <div class="summary-text flight-date"><span class="hide">Journey Date </span>Thu, Oct 01</div>
    <div class="summary-text flight-depart-time"><span class="hide">Departure Time </span>6:00am</div>
    <div class="summary-text flight-arrival-time"><span class="hide">Arrival Time </span>10:21am</div>
    <div class="summary-text stop-count"><span class="hide">Number of stops </span>1 stop</div>
    <div class="summary-text flight-duration">, Journey duration 7h 21m</div>
    <div class="summary-text cabin-name"><span class="hide">Cabin Name </span>Main Classic</div></div>
  <span class="changeableNonrefundable">Changeable / Nonrefundable</span>
  <div id="trip-total-content">
    <div class="line-item">1 Passenger</div>
    <div class="line-item">Flights $407.44</div>
    <div class="line-item">Taxes, Fees &amp; Charges <span>opens in a new popup</span> <span>(1 Passenger)</span> $55.76</div>
    <div class="line-item">Amount Due <span>opens in a new popup</span> $463.20 USD</div>
    <div class="line-item">Amount Due <span>opens in a new popup</span> $463.20 USD</div>
  </div></body></html>`;

test("get_trip_summary: reads slice, price lines, amount due and cart id", async () => {
  const { out } = await run("get_trip_summary", summaryHtml, {}, { url: "https://www.delta.com/completepurchase/trip-summary?cacheKeySuffix=k&cartId=cart-123" });
  assert.equal(out.status, "ok");
  assert.equal(out.step, "trip_summary");
  assert.equal(out.cart_id, "cart-123");
  assert.deepEqual(out.slices, [{ trip_type: "One Way", flight_numbers: ["DL 2441", "DL 693"], origin: "CVG", destination: "SFO", date_display: "Thu, Oct 01", departure_time: "6:00am", arrival_time: "10:21am", stops: 1, duration_display: "7h 21m", cabin: "Main Classic" }]);
  assert.equal(out.passengers, 1);
  assert.deepEqual(out.price_lines, [{ label: "Flights", amount: 407.44 }, { label: "Taxes, Fees & Charges", amount: 55.76 }]);
  assert.equal(out.amount_due, 463.2);
  assert.equal(out.currency, "USD");
  assert.equal(out.refundability, "Changeable / Nonrefundable");
});

// --- get_page_context v2 ----------------------------------------------------------------------
const home = `<html><body><header><button id="login-trigger">Log in</button></header></body></html>`;

test("get_page_context: homepage signed out, settled, suggests search and login", async () => {
  const { out } = await run("get_page_context", home, {}, { tools: ["search_flights", "login", "get_page_context", "navigate_to_page"] });
  assert.equal(out.page_type, "home");
  assert.equal(out.signed_in, false);
  assert.equal(out.unsettled, false);
  assert.deepEqual(out.available_tools, ["get_page_context", "login", "navigate_to_page", "search_flights"]);
  assert.ok(out.suggested_next_steps.some(s => s.startsWith("Use login")));
});

test("get_page_context: a header 'Log in' button (not #login-trigger) still means signed out; Log out means signed in", async () => {
  assert.equal((await run("get_page_context", `<html><body><header><a>Log in</a></header></body></html>`, {}, { url: resultsUrl })).out.signed_in, false);
  assert.equal((await run("get_page_context", `<html><body><header><a>Log Out</a></header></body></html>`, {}, { url: resultsUrl })).out.signed_in, true);
});

test("get_page_context: loading indicators set unsettled with reasons", async () => {
  const { out } = await run("get_page_context", `<html><body><idp-flight-row-skeleton>x</idp-flight-row-skeleton><idp-spinner>x</idp-spinner></body></html>`, {}, { url: resultsUrl, readyState: "interactive" });
  assert.equal(out.unsettled, true);
  assert.deepEqual(out.unsettled_reasons, ["document_loading", "results_loading", "page_spinner"]);
  assert.match(out.suggested_next_steps[0], /still loading/);
  const checkout = await run("get_page_context", `<html><body><div class="spinnerView">x</div></body></html>`, {}, { url: "https://www.delta.com/completepurchase/trip-summary?cartId=c" });
  assert.deepEqual(checkout.out.unsettled_reasons, ["checkout_loading"]);
});

test("get_page_context: open experience drawer is a pending choice; seat badges are not messages", async () => {
  const { out } = await run("get_page_context", results(true).replace("<idp-search-results>", '<idp-search-results><div role="alert">3 left at this price</div>'), {}, { url: resultsUrl, tools: ["select_fare", "select_fare_experience", "list_flight_results", "search_flights"] });
  assert.equal(out.page_type, "flight_results");
  assert.equal(out.pending_choice, "fare_experience");
  assert.deepEqual(out.page_messages, []);
  assert.ok(out.suggested_next_steps.some(s => s.includes("select_fare_experience")));
  assert.ok(!out.suggested_next_steps.some(s => s.startsWith("Use list_flight_results")));
});

test("get_page_context: trip summary and review-pay are cart pages whose suggestions never abandon the cart", async () => {
  for (const [path, type] of [["trip-summary", "trip_summary"], ["review-pay", "review_and_pay"]]) {
    const { out } = await run("get_page_context", home, {}, { url: `https://www.delta.com/completepurchase/${path}?cacheKeySuffix=k&cartId=cart-9`, tools: ["get_trip_summary", "search_flights", "navigate_to_page"] });
    assert.equal(out.page_type, type);
    assert.equal(out.cart_id, "cart-9");
    assert.ok(out.suggested_next_steps[0].includes("get_trip_summary"));
    assert.ok(!out.suggested_next_steps.some(s => /^Use (search_flights|navigate_to_page)/.test(s)), out.suggested_next_steps.join(" | "));
  }
});

test("get_page_context: SFAF code on results is reported and not read as zero flights", async () => {
  const { out } = await run("get_page_context", `<html><body><p>Something went wrong #SFAF001_429</p></body></html>`, {}, { url: resultsUrl, tools: ["search_flights"] });
  assert.ok(out.page_messages.some(m => m.includes("SFAF001_429")));
  assert.ok(out.suggested_next_steps.some(s => s.includes("do not treat it as zero flights")));
});

// --- continue_to_review_and_pay ---------------------------------------------------------------
test("continue_to_review_and_pay: schedules the Continue click after settling; refuses elsewhere or while loading", async () => {
  const clicks = [];
  const page = `<html><body><div id="trip-total-content"><div class="line-item">Amount Due $123.41 USD</div></div><button class="idp-btn idp-primary">CONTINUE TO REVIEW &amp; PAY</button></body></html>`;
  const ok = await run("continue_to_review_and_pay", page, {confirm:true,expected_total_due:123.41}, { url: "https://www.delta.com/completepurchase/trip-summary?cartId=c-1", onClick: el => clicks.push(el.tagName) });
  assert.deepEqual(ok.out.status, "navigation_scheduled");
  assert.equal(ok.out.cart_id, "c-1");
  assert.deepEqual(clicks, []);
  ok.scheduled[0]();
  assert.deepEqual(clicks, ["BUTTON"]);
  assert.equal((await run("continue_to_review_and_pay", page, {confirm:true,expected_total_due:123.41}, { url: "https://www.delta.com/completepurchase/review-pay?cartId=c-1" })).out.status, "error");
  assert.equal((await run("continue_to_review_and_pay", page.replace("<body>", '<body><div class="spinnerView">x</div>'), {confirm:true,expected_total_due:123.41}, { url: "https://www.delta.com/completepurchase/trip-summary?cartId=c-1" })).out.status, "not_ready");
});

// --- QA subagent findings (2026-09-30) ------------------------------------------------------
test("get_trip_summary: amount due followed by a seat badge, footnoted flight numbers, AMEX block ignored", async () => {
  const html = summaryHtml
    .replace('<span class="hide">Flight number </span>DL2441, DL693', '<span class="hide">Flight number </span>DL2441, DL5280<sup>1</sup>')
    .replace(/<div class="line-item">Amount Due[\s\S]*?<\/div>\s*<div class="line-item">Amount Due[\s\S]*?<\/div>/, '<div class="line-item">Amount Due <span>opens in a new popup</span> <span>(1 Passenger)</span> $463.20 USD 5 left at this price</div>')
    + '<div class="amex">Total After Statement Credit $0.00 USD</div>';
  const { out } = await run("get_trip_summary", html, {}, { url: "https://www.delta.com/completepurchase/review-pay?cartId=c" });
  assert.equal(out.step, "review_and_pay");
  assert.deepEqual(out.slices[0].flight_numbers, ["DL 2441", "DL 5280"]);
  assert.equal(out.amount_due, 463.2);
  assert.equal(out.currency, "USD");
  assert.deepEqual(out.warnings, []);
});

test("get_trip_summary: unreadable amount due is a warning, not a silent null", async () => {
  const html = summaryHtml.replace(/<div class="line-item">Amount Due[\s\S]*?<\/div>\s*<div class="line-item">Amount Due[\s\S]*?<\/div>/, "");
  const { out } = await run("get_trip_summary", html, {}, { url: "https://www.delta.com/completepurchase/trip-summary?cartId=c" });
  assert.equal(out.amount_due, null);
  assert.match(out.warnings[0], /Amount Due could not be read/);
});

test("select_fare: on return results, an experience-specific cell selects directly (navigation_scheduled, no drawer)", async () => {
  const clicks = [];
  const html = results().replace('<a id="#BMAIN-0-row-5" role="button">Delta Main</a>', '<span class="brand-name">Delta Main Classic</span>');
  const { out, scheduled } = await run("select_fare", html, { result_index: 5, brand_code: "BMAIN" },
    { url: "https://www.delta.com/flightsearch/search-results/return?cacheKeySuffix=k", onClick: el => clicks.push(el.getAttribute("tabindex")) });
  assert.equal(out.status, "navigation_scheduled");
  assert.equal(out.fare_label, "Delta Main Classic");
  assert.equal(out.price_display, "$399");
  assert.deepEqual(clicks, []);
  scheduled[0]();
  assert.deepEqual(clicks, ["0"]);
});

test("select_fare: 'Round Trip From' and 'Accept Conditions' labels do not leak into details", async () => {
  const drawer = drawerHtml.replace("<span>One-Way</span><span>$399</span>", "<span>Round Trip From</span><span>$399</span>").replace("Accept Restrictions", "Accept Conditions");
  const html = results().replace("</idp-search-results>", "</idp-search-results>");
  const { out } = await run("select_fare", html, { result_index: 5, brand_code: "BMAIN" }, {
    url: resultsUrl,
    onClick: (el, doc) => { if (el.getAttribute("tabindex") === "0") { const holder = new Document(drawer).root.children[0]; const row = doc.getElementById("flight-results-grid-5"); row.childNodes.push(holder); holder.parentNode = row; } }
  });
  assert.ok(!out.experiences[0].details.some(d => /Round Trip|Accept/.test(d)), out.experiences[0].details.join(" | "));
});

test("select_fare_experience: round-trip outbound goes to return results, not Trip Summary", async () => {
  const document = new Document(results(true));
  const { out } = await (async () => {
    const r = await run("select_fare_experience", results(true), { code: "CMAIN" }, { url: resultsUrl });
    return r;
  })();
  assert.equal(out.next_page, "trip_summary", "no stored round trip -> trip summary");
  // with a stored ROUND_TRIP search
  const src = load("select_fare_experience");
  const doc = new Document(results(true));
  Object.getPrototypeOf(doc.body).click = function () {};
  const ctx = { document: doc, URL, URLSearchParams, JSON, Number, Date, location: { href: resultsUrl, pathname: "/flightsearch/search-results", search: "?cacheKeySuffix=k" },
    localStorage: { getItem: () => JSON.stringify({ tripType: "ROUND_TRIP" }) }, getComputedStyle: () => ({ visibility: "visible" }), setTimeout: fn => 0 };
  const [tool] = runInNewContext(`(${src})`, ctx);
  const rt = plain(await tool.execute({ code: "CMAIN" }));
  assert.equal(rt.next_page, "return_results");
  assert.match(rt.next_step, /return flights/);
});

test("get_page_context: return results leg; styling classes named *alert are not messages", async () => {
  const html = `<html><body><div class="flight-line__date-alert">Fri, Oct 9</div><div class="fare-cell-seats-left text-alert">2 left at this price</div><div role="alert">Real problem here</div></body></html>`;
  const { out } = await run("get_page_context", html, {}, { url: "https://www.delta.com/flightsearch/search-results/return?cacheKeySuffix=k", tools: ["list_flight_results", "select_fare"] });
  assert.equal(out.page_type, "flight_results");
  assert.equal(out.results_leg, "return");
  assert.deepEqual(out.page_messages, ["Real problem here"]);
  assert.ok(out.suggested_next_steps.some(s => s.includes("return flights")));
});

test("continue_to_review_and_pay: on Review and Pay says it is already there", async () => {
  const { out } = await run("continue_to_review_and_pay", "<html><body></body></html>", {confirm:true,expected_total_due:123.41}, { url: "https://www.delta.com/completepurchase/review-pay?cartId=c" });
  assert.match(out.error_message, /Already on Review and Pay/);
});

test("select_fare_experience: a code the drawer does not offer is experience_not_offered with offered_codes", async () => {
  const { out, scheduled } = await run("select_fare_experience", results(true), { code: "EFIRST" }, { url: resultsUrl });
  assert.equal(out.status, "experience_not_offered");
  assert.deepEqual(out.offered_codes, ["BMAIN", "CMAIN"]);
  assert.equal(scheduled.length, 0);
});

test("select_fare: experiences carry basis_display and badges", async () => {
  const { out } = await run("select_fare", results(), { result_index: 5, brand_code: "BMAIN" }, { url: resultsUrl, onClick: (el, doc) => openDrawer(el, doc) });
  const [basic, classic] = out.experiences;
  assert.equal(basic.basis_display, "One-Way");
  assert.deepEqual(classic.badges, ["Most Popular"]);
  assert.ok(!classic.details.includes("Most Popular"));
});
