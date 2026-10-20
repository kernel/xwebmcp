import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { Document } from "./etsy-dom.mjs";

// Fabricated aa.com pages (no real traveler, account or payment data). Shadow DOM is flattened
// into light DOM; the tools fall back to light DOM when no shadowRoot exists.
const load = name => readFileSync(new URL(`../domains/aa.com/${name}.js`, import.meta.url), "utf8");
const plain = v => JSON.parse(JSON.stringify(v));

async function run(name, html, input = {}, { url = "https://www.aa.com/booking/choose-flights/1?sid=x", onClick = () => {}, pending } = {}) {
  const document = new Document(html);
  const proto = Object.getPrototypeOf(document.body);
  proto.click = function () { onClick(this, document); };
  if (!Object.getOwnPropertyDescriptor(proto, "checked")) Object.defineProperty(proto, "checked", { get() { return this.hasAttribute("checked"); }, set(v) { v ? this.setAttribute("checked", "") : this.removeAttribute("checked"); }, configurable: true });
  if (!Object.getOwnPropertyDescriptor(proto, "type")) Object.defineProperty(proto, "type", { get() { return this.getAttribute("type") || (this.localName === "button" ? "submit" : ""); }, configurable: true });
  if (!proto.getRootNode) proto.getRootNode = function () { return document; };
  const u = new URL(url);
  const scheduled = [];
  const context = { document, URL, JSON, Number, Math, Date, RegExp, Event: class { constructor(t) { this.type = t; } },
    location: { href: u.href, pathname: u.pathname, search: u.search, hostname: u.hostname },
    setTimeout: (fn, ms) => { if (ms === 100) { scheduled.push(fn); return 0; } setImmediate(fn); return 0; } };
  context.globalThis = context;
  if (pending) context.__xwebmcpAaPendingNavigation = pending;
  const [tool] = runInNewContext(`(${load(name)})`, context);
  const out = await tool.execute(input, {});
  return { out: plain(out), document, scheduled, tool, context };
}

const slice = (i, num, groups) => `<app-slice-details id="slice-details-${i}"><div class="slice-details"><div class="matrix-flight-card"><div class="origin"><div class="city-code">CVG</div><div class="time">6:00 AM</div></div><div class="destination"><div class="city-code">DFW</div><div class="time">7:40 AM</div></div><div class="duration">2h 40m</div><div class="stops"><span class="nonstop">Nonstop</span></div><span class="flight-number"> ${num} </span><span class="aircraft"> 738-Boeing 737 </span></div>
  ${groups.map(([code, name, price]) => `<button type="button" id="flight-${i}-product-group-${code}" aria-expanded="false" class="btn-flight ${code}"><span class="hidden-product-group">${name}</span><div class="trip-type">Round trip from</div><span class="per-pax-amount">$${price}</span></button>`).join("")}<app-drawer></app-drawer></div></app-slice-details>`;
const fare = (name, price, benefits, radios, id, header = "Round trip") => `<div class="fare"><div class="product-header"><div class="trip-type">${header}</div></div><div class="product-type"> ${name} </div><div class="total"><span class="amount">$${price}</span></div><div class="benefits">${benefits.map(b => `<div class="benefit"><div class="text"><span>${b}</span></div></div>`).join("")}</div>
  <div class="refund-options">${radios.map((r, j) => `<input type="radio" id="${id}-${j}" name="${id}"${j === 0 ? "" : ""}><label for="${id}-${j}"><span class="message">${r[0]}</span><span class="amount"> + $${r[1]} </span></label>`).join("")}</div><div class="select"><button type="button" id="sel-${id}">Select</button></div></div>`;
const drawerHtml = fare("Basic Economy", 149, ["Pay more to check bags", "No changes allowed"], [], "be", "One way MOST RESTRICTIONS") +
  fare("Main", 204, ["Pay to check bags", "Choose a Main Cabin seat", "Changes allowed"], [["Full refund to travel credit", 0], ["Full refund to original form of payment", 96]], "main") +
  fare("Main Plus", 271, ["Check 1 bag free", "Choose an extra legroom seat", "Changes allowed"], [], "plus");
const results = (drawer = "") => `<html><body>${slice(0, "AA 1056", [["MAIN", "Main", 839], ["PREMIUM", "Premium", 1050]]).replace("<app-drawer></app-drawer>", `<app-drawer>${drawer}</app-drawer>`)}${slice(1, "AA 807", [["MAIN", "Main", 839]])}</body></html>`;

test("aa list_flight_results: rows, fare groups, leg and wrong page", async () => {
  const { out } = await run("list_flight_results", results());
  assert.equal(out.status, "ok");
  assert.equal(out.leg, "departing");
  assert.equal(out.result_count, 2);
  assert.deepEqual(out.flights[0].flight_numbers, ["AA 1056"]);
  assert.equal(out.flights[0].duration_minutes, 160);
  assert.equal(out.flights[0].stops, 0);
  assert.deepEqual(out.flights[0].fare_groups.map(g => [g.group_code, g.from_price]), [["MAIN", 839], ["PREMIUM", 1050]]);
  assert.equal((await run("list_flight_results", results(), {}, { url: "https://www.aa.com/booking/choose-flights/2?sid=x" })).out.leg, "returning");
  assert.equal((await run("list_flight_results", results(), {}, { url: "https://www.aa.com/homePage.do" })).out.status, "wrong_page");
});

test("aa select_fare: opens the drawer and returns disclosures, refund options and Basic consent", async () => {
  const { out } = await run("select_fare", results(), { result_index: 0, group_code: "MAIN", expected_flight_numbers: ["AA 1056"] }, {
    onClick: (el, doc) => { if (el.id === "flight-0-product-group-MAIN") { el.setAttribute("aria-expanded", "true"); const d = doc.querySelector("#slice-details-0 app-drawer"); const holder = new Document(`<div>${drawerHtml}</div>`).root.children[0]; d.childNodes.push(holder); holder.parentNode = d; } }
  });
  assert.equal(out.status, "fare_choice_required");
  assert.deepEqual(out.fares.map(f => [f.fare_name, f.price, f.requires_accepting_restrictions, f.checked_bag_included, f.changes_allowed]),
    [["Basic Economy", 149, true, false, false], ["Main", 204, false, false, true], ["Main Plus", 271, false, true, true]]);
  assert.deepEqual(out.fares[1].refund_options.map(r => r.extra_price), [0, 96]);
  assert.equal((await run("select_fare", results(), { result_index: 0, group_code: "MAIN", expected_flight_numbers: ["AA 9"] })).out.status, "row_changed");
  assert.equal((await run("select_fare", results(), { result_index: 1, group_code: "PREMIUM" })).out.status, "group_not_offered");
});

test("aa select_fare_option: Basic needs consent, Main schedules navigation, duplicates refused", async () => {
  const page = results(drawerHtml);
  const refused = await run("select_fare_option", page, { result_index: 0, fare_name: "Basic Economy" });
  assert.equal(refused.out.status, "consent_required");
  assert.equal(refused.scheduled.length, 0);
  const clicks = [];
  const ok = await run("select_fare_option", page, { result_index: 0, fare_name: "Main", refund_option_index: 1 }, { onClick: (el) => { clicks.push(el.id); if (el.tagName === "LABEL") el.ownerDocument.getElementById(el.getAttribute("for")).checked = true; } });
  assert.equal(ok.out.status, "selection_scheduled");
  assert.equal(ok.out.refund_option, "Full refund to original form of payment");
  assert.equal(ok.out.expected_next_page, "results_returning");
  assert.equal(ok.scheduled.length, 1, "Select is pressed only after settling");
  assert.ok(!clicks.includes("sel-main"));
  ok.scheduled[0]();
  assert.ok(clicks.includes("sel-main"));
  assert.equal((await run("select_fare_option", page, { result_index: 0, fare_name: "Polaris" })).out.status, "fare_not_offered");
  const dup = await run("select_fare_option", page, { result_index: 0, fare_name: "Main" }, { pending: { at: Date.now(), from: "https://www.aa.com/booking/choose-flights/1?sid=x" } });
  assert.equal(dup.out.status, "error");
  const basic = await run("select_fare_option", page, { result_index: 0, fare_name: "Basic Economy", accept_restrictions: true }, {
    onClick: (el, doc) => { if (el.id === "sel-be") { const d = new Document(`<div class="basic-economy-dialog"><button id="btn-upgrade">Move to Main</button><button id="btn-no-upgrade">Accept restrictions</button></div>`).root.children[0]; doc.body.childNodes.push(d); d.parentNode = doc.body; } }
  });
  assert.equal(basic.out.status, "selection_scheduled");
  assert.equal(basic.out.restrictions_accepted, true);
  assert.equal(basic.out.expected_next_page, "trip_summary");
});

const review = (extra = "") => `<html><body><app-payment-page><app-trip-insurance-wrapper><app-trip-insurance-legacy>
  <adc-radio-button value="purchase" id="allianz-yes-selection"><span>Yes, protect my trip for $65.01 total.</span></adc-radio-button>
  <adc-radio-button value="decline" id="allianz-no-selection"><span>No, do not protect my trip.</span></adc-radio-button></app-trip-insurance-legacy>
  <button id="trip-insurance-continue-button">Continue</button></app-trip-insurance-wrapper>${extra}
  <app-flight-leg>Depart CVG at 6:00 AM and arrive at DFW at 7:40 AM Tuesday, October 20, 2026 AA 1056 · Main Cabin</app-flight-leg>
  <app-cost-summary-tall><h2>Cost summary</h2><span>Main</span><span> x 1</span><div>$751.63</div><span>Subtotal</span><div>$751.63</div><a>Taxes and carrier imposed fees</a><div>$87.17</div><span>Total amount due</span><div>(All passengers)</div><div>$838.80</div></app-cost-summary-tall></app-payment-page></body></html>`;
const reviewUrl = { url: "https://www.aa.com/ecommerce/checkout-app/cart/abc" };
const payment = `<app-payment-method><agc-radio-button id="s0"><input type="radio" name="paymentMethod" value="SAVED_CREDIT_CARD:0" data-card-info="- 2000" checked><img alt="American Express">Card number 2000 Expiration 05/29 Card nickname EXAMPLE Primary</agc-radio-button>
  <agc-radio-button id="cc"><input type="radio" name="paymentMethod" value="CREDIT_CARD">Credit / debit card</agc-radio-button>
  <agc-radio-button id="pp"><input type="radio" name="paymentMethod" value="PAYPAL">PayPal</agc-radio-button>
  <agc-radio-button id="hold"><input type="radio" name="paymentMethod" value="HOLD">Hold for 24 hours</agc-radio-button></app-payment-method>
  <app-credit-card-stored-method><input id="cvvInput" name="cvv" type="password"></app-credit-card-stored-method><app-payment-action><button>Pay now</button></app-payment-action>`;

test("aa get_trip_summary and get_checkout_step on Review and pay", async () => {
  const sum = (await run("get_trip_summary", review(), {}, reviewUrl)).out;
  assert.equal(sum.status, "ok");
  assert.deepEqual([sum.flights[0].origin, sum.flights[0].destination, sum.flights[0].flight_numbers[0], sum.flights[0].cabin], ["CVG", "DFW", "AA 1056", "Main Cabin"]);
  assert.deepEqual([sum.fare_name, sum.base_fare, sum.taxes_and_fees, sum.total_due], ["Main", 751.63, 87.17, 838.8]);
  const step = (await run("get_checkout_step", review(), {}, reviewUrl)).out;
  assert.equal(step.step, "review_and_pay");
  assert.equal(step.insurance_choice, "unanswered");
  assert.equal(step.purchase_button_visible, false);
  const paying = (await run("get_checkout_step", review(payment), {}, reviewUrl)).out;
  assert.equal(paying.payment_method, "SAVED_CREDIT_CARD:0");
  assert.equal(paying.cvv_required, true);
  assert.equal(paying.purchase_button_visible, true);
  assert.equal((await run("get_trip_summary", review(), {}, { url: "https://www.aa.com/homePage.do" })).out.status, "wrong_page");
});

test("aa set_trip_protection: premium check, accept and decline", async () => {
  const onClick = (el) => { const rb = el.closest("adc-radio-button") || el; if (rb.localName === "adc-radio-button") { for (const r of el.ownerDocument.querySelectorAll("adc-radio-button")) r.removeAttribute("checked"); rb.setAttribute("checked", ""); } };
  const q = (await run("set_trip_protection", review(), { choice: "accept" }, { ...reviewUrl, onClick })).out;
  assert.equal(q.status, "premium_changed");
  assert.equal(q.quoted_premium, 65.01);
  const a = await run("set_trip_protection", review(), { choice: "accept", expected_premium: 65.01 }, { ...reviewUrl, onClick });
  assert.equal(a.out.status, "set");
  assert.equal(a.document.getElementById("allianz-yes-selection").hasAttribute("checked"), true);
  const d = (await run("set_trip_protection", review(), { choice: "decline" }, { ...reviewUrl, onClick })).out;
  assert.deepEqual([d.status, d.choice, d.previous_choice], ["set", "decline", "unanswered"]);
});

test("aa continue_checkout: total guard, insurance requirement, payment boundary, sign-out", async () => {
  assert.equal((await run("continue_checkout", review(), { expected_total: 1 }, reviewUrl)).out.status, "total_changed");
  assert.equal((await run("continue_checkout", review(), { expected_total: 838.8 }, reviewUrl)).out.status, "choice_required");
  const paid = review(payment).replace("<button id=\"trip-insurance-continue-button\">Continue</button>", "");
  assert.equal((await run("continue_checkout", paid, { expected_total: 838.8 }, reviewUrl)).out.status, "at_payment");
  const summary = `<html><body><app-summary><div>Total $838.80 (all passengers)</div><button id="login-continue-btn">Log in and continue</button><button id="continue-as-guest-btn">Continue as guest</button></app-summary></body></html>`;
  const out = await run("continue_checkout", summary, { expected_total: 838.8 }, { url: "https://www.aa.com/booking/your-trip-summary?sid=x" });
  assert.equal(out.out.status, "login_required");
  assert.equal(out.scheduled.length, 0);
  const ok = await run("continue_checkout", summary.replace(/<button id="login.*<\/button>/, "<button id=\"continue-btn\">Continue</button>"), { expected_total: 838.8 }, { url: "https://www.aa.com/booking/your-trip-summary?sid=x" });
  assert.equal(ok.out.status, "continued");
  assert.equal(ok.out.navigation_scheduled, true);
  assert.equal(ok.scheduled.length, 1);
  const pax = `<html><body><app-passenger-page><app-trip-total>Your trip total $838.80</app-trip-total><div role="alert">Please correct the following errors Known traveler number</div></app-passenger-page><button>Continue</button></body></html>`;
  const blocked = await run("continue_checkout", pax, { expected_total: 838.8 }, { url: "https://www.aa.com/airfare-sales/ui/passenger-ui/" });
  assert.equal(blocked.out.status, "missing_required_fields");
  const mmx = `<html><body><app-storefront><app-mmx><input type="radio" name="milesOption" value="5000" checked><input type="radio" name="milesOption" value="No thanks"></app-mmx><app-cost-summary>Total amount due (All passengers) $0.00</app-cost-summary><button>Continue without extras</button></app-storefront></body></html>`;
  assert.equal((await run("continue_checkout", mmx, { expected_total: 0 }, { url: "https://www.aa.com/ancillaries/offers/storefront/1/x" })).out.status, "choice_required");
});

test("aa payment tools: list without names, select saved card or method, refuse wrong total", async () => {
  const page = review(payment);
  const list = (await run("list_payment_methods", page, {}, reviewUrl)).out;
  assert.deepEqual(list.saved_cards.map(c => [c.last_four, c.brand, c.expiration, c.primary]), [["2000", "American Express", "05/29", true]]);
  assert.ok(!JSON.stringify(list).includes("EXAMPLE"), "card nicknames are not returned");
  assert.equal(list.selected, "SAVED_CREDIT_CARD:0");
  const onClick = (el) => { if (el.localName === "input") { for (const i of el.ownerDocument.querySelectorAll("input[name=paymentMethod]")) i.removeAttribute("checked"); el.setAttribute("checked", ""); } };
  const pp = (await run("select_payment_method", page, { method_code: "PAYPAL", expected_total: 838.8 }, { ...reviewUrl, onClick })).out;
  assert.deepEqual([pp.status, pp.selected, pp.previous], ["selected", "PAYPAL", "SAVED_CREDIT_CARD:0"]);
  assert.equal((await run("select_payment_method", page, { saved_card_last_four: "9999", expected_total: 838.8 }, reviewUrl)).out.status, "not_found");
  assert.equal((await run("select_payment_method", page, { method_code: "PAYPAL", expected_total: 1 }, reviewUrl)).out.status, "total_changed");
  const { tool } = await run("select_payment_method", page, { method_code: "PAYPAL", expected_total: 838.8 }, reviewUrl);
  assert.ok(!tool.tool.inputSchema.properties.method_code.enum.includes("HOLD"));
});

const bagsPage = (count) => `<html><body><app-storefront><app-prepaidbags><app-flight-tab><button aria-selected="true">CVG - DFW Depart</button></app-flight-tab>
  <app-passenger-bag-selector><button${count === 0 ? " disabled" : ""}><agc-icon icon="action:subtract"></agc-icon>Remove Bag</button><span> ${count} bags </span><button><agc-icon icon="action:plus"></agc-icon>Add Bag</button></app-passenger-bag-selector>
  <app-bag-prices>1st bag $45.00 per person 2nd bag $55.00 per person</app-bag-prices></app-prepaidbags><app-cost-summary>Total amount due (All passengers) $${(count * 45).toFixed(2)}</app-cost-summary></app-storefront></body></html>`;

test("aa bags: list prices and counts; set restores on a price mismatch", async () => {
  const url = { url: "https://www.aa.com/ancillaries/offers/storefront/3/x" };
  const list = (await run("list_trip_extras", bagsPage(0), {}, url)).out;
  assert.equal(list.extras_kind, "checked_bags");
  assert.deepEqual(list.options.map(o => o.price), [45, 55]);
  assert.deepEqual(list.passengers, [{ passenger_index: 0, bags_selected: 0, can_add: true, can_remove: false }]);
  const counter = (el, doc) => {
    const span = doc.querySelector("app-passenger-bag-selector span");
    let n = Number(span.textContent.trim().split(" ")[0]);
    n += /Add/.test(el.textContent) ? 1 : -1;
    span.textContent = ` ${n} bags `;
    doc.querySelector("app-cost-summary").textContent = `Total amount due (All passengers) $${(n * 45).toFixed(2)}`;
    const rem = doc.querySelector("app-passenger-bag-selector button");
    n === 0 ? rem.setAttribute("disabled", "") : rem.removeAttribute("disabled");
  };
  const ok = (await run("set_checked_bags", bagsPage(0), { passenger_index: 0, bag_count: 1, expected_extras_total: 45 }, { ...url, onClick: counter })).out;
  assert.deepEqual([ok.status, ok.previous_bag_count, ok.bag_count, ok.extras_total], ["updated", 0, 1, 45]);
  const mismatch = (await run("set_checked_bags", bagsPage(0), { passenger_index: 0, bag_count: 1, expected_extras_total: 1 }, { ...url, onClick: counter })).out;
  assert.deepEqual([mismatch.status, mismatch.bag_count, mismatch.extras_total], ["price_mismatch", 0, 0]);
});

const seatPage = `<html><body><app-seat-selection><app-flight-details><button aria-selected="true">CVG-DFW</button><button aria-selected="false">DFW-CVG</button> AA 1056 • Boeing 737-800</app-flight-details>
  <app-seat-map><span id="seatA11y-8B">available, Main Cabin Extra, More legroom, Seat 8B, $43 or 4.5K for TEST PASSENGER</span><button id="seatBtn-8B" aria-pressed="false">$43</button>
  <span id="seatA11y-21E">available, Available seat, Seat 21E available; select for no cost for TEST PASSENGER</span><button id="seatBtn-21E" aria-pressed="false"></button>
  <span id="seatA11y-8A">Seat 8A, unavailable</span><button id="seatBtn-8A"></button></app-seat-map>
  <app-pax-details><button class="pax-details-btn">Passenger 1 of 1, TEST PASSENGER, is not assigned a seat, total seats cost (all passengers) no charge</button></app-pax-details>
  <app-cost-summary>Total seats (all passengers) $0 or 0K miles</app-cost-summary><a>Skip seats for all flights</a></app-seat-selection></body></html>`;

test("aa seats: list without names, price guard, select and skip", async () => {
  const url = { url: "https://www.aa.com/ancillaries/offers/seats/2/x" };
  const map = (await run("list_seat_map", seatPage, {}, url)).out;
  assert.equal(map.status, "ok");
  assert.deepEqual(map.seats.map(s => [s.seat, s.seat_type, s.price]), [["8B", "Main Cabin Extra", 43], ["21E", "Standard", 0]]);
  assert.deepEqual(map.passengers, [{ passenger_index: 0, seat: null }]);
  assert.ok(!JSON.stringify(map).includes("TEST PASSENGER"));
  assert.equal(map.flight, "CVG-DFW AA 1056");
  assert.equal((await run("select_seat", seatPage, { seat: "8B", max_price: 10 }, url)).out.status, "price_above_limit");
  assert.equal((await run("select_seat", seatPage, { seat: "8A", max_price: 10 }, url)).out.status, "seat_unavailable");
  const sel = (await run("select_seat", seatPage, { seat: "21E", max_price: 0 }, { ...url, onClick: (el, doc) => { if (el.id === "seatBtn-21E") doc.querySelector("app-pax-details button").textContent = "Passenger 1 of 1, TEST PASSENGER, Seat 21E, total seats cost (all passengers) no charge"; } })).out;
  assert.deepEqual([sel.status, sel.seat, sel.price, sel.previous_seat], ["selected", "21E", 0, null]);
  const skip = await run("skip_seat_selection", seatPage, {}, url);
  assert.equal(skip.out.status, "skip_scheduled");
  assert.equal(skip.scheduled.length, 1);
});

test("aa get_page_context: page types, pending navigation scoped to its URL, site error", async () => {
  const ctx = (await run("get_page_context", review(), {}, reviewUrl)).out;
  assert.equal(ctx.page_type, "review_and_pay");
  assert.equal(ctx.total_due, 838.8);
  assert.ok(ctx.available_tools.includes("set_trip_protection"));
  const pend = (await run("get_page_context", results(), {}, { pending: { at: Date.now(), from: "https://www.aa.com/booking/choose-flights/1?sid=x" } })).out;
  assert.equal(pend.navigation_pending, true);
  const stale = (await run("get_page_context", results(), {}, { pending: { at: Date.now(), from: "https://www.aa.com/other" } })).out;
  assert.equal(stale.navigation_pending, false);
  const err = (await run("get_page_context", "<html><body><div><span>Our system is having trouble</span></div></body></html>", {}, reviewUrl)).out;
  assert.ok(err.dialogs.includes("site_error"));
  assert.equal((await run("get_page_context", "<html><body></body></html>", {}, { url: "https://login.aa.com/login" })).out.page_type, "login");
});

test("aa continue_checkout on seats: Next flight must actually switch flights", async () => {
  const url = { url: "https://www.aa.com/ancillaries/offers/seats/2/x" };
  const page = seatPage.replace("<a>Skip seats", "<button id=\"btnContinue\">Next flight</button><a>Skip seats");
  const stuck = (await run("continue_checkout", page, { expected_total: 0 }, url)).out;
  assert.equal(stuck.status, "error");
  const moved = (await run("continue_checkout", page, { expected_total: 0 }, { ...url, onClick: (el, doc) => { if (el.id === "btnContinue") { const [a, b] = doc.querySelectorAll("app-flight-details button"); a.setAttribute("aria-selected", "false"); b.setAttribute("aria-selected", "true"); } } })).out;
  assert.deepEqual([moved.status, moved.now_showing, moved.navigation_scheduled], ["continued", "next_flight", false]);
});

test("aa get_page_context: legend text mentioning an unavailable seat is not a site error; pending skips waiting", async () => {
  const url = { url: "https://www.aa.com/ancillaries/offers/seats/2/x" };
  const legend = seatPage.replace("<app-cost-summary>", "<div><span>Seats shown in gray on the seat map</span><span>Unavailable</span></div><app-cost-summary>");
  assert.ok(!(await run("get_page_context", legend, {}, url)).out.dialogs.includes("site_error"));
  const unavailable = seatPage.replace("<app-cost-summary>", "<div><span>Seat map unavailable. Please check back.</span></div><app-cost-summary>");
  assert.ok((await run("get_page_context", unavailable, {}, url)).out.dialogs.includes("site_error"));
  const t0 = Date.now();
  const pend = (await run("get_page_context", "<html><body></body></html>", { wait_for_settled_seconds: 5 }, { url: "https://www.aa.com/booking/choose-flights/1?sid=x", pending: { at: Date.now(), from: "https://www.aa.com/booking/choose-flights/1?sid=x" } })).out;
  assert.equal(pend.navigation_pending, true);
  assert.ok(Date.now() - t0 < 1000);
});
