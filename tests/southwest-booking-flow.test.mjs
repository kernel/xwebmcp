import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { Document } from "./etsy-dom.mjs";

const load = (name) => readFileSync(new URL(`../domains/southwest.com/${name}.js`, import.meta.url), "utf8");
const plain = (v) => JSON.parse(JSON.stringify(v));
const BASE = "https://www.southwest.com";

function dom(html) {
  const document = new Document(html);
  const proto = Object.getPrototypeOf(document.body);
  if (!Object.getOwnPropertyDescriptor(proto, "checked")) Object.defineProperty(proto, "checked", { get() { return this.hasAttribute("checked"); }, set(v) { v ? this.setAttribute("checked", "") : this.removeAttribute("checked"); }, configurable: true });
  proto.scrollIntoView = () => {};
  return document;
}

function context(document, path, extra = {}) {
  const u = new URL(BASE + path);
  const ctx = { document, navigator: {}, URL, JSON, Number, Math, Date, RegExp, location: { href: u.href, pathname: u.pathname, search: u.search }, setTimeout: (fn) => { setImmediate(fn); return 0; }, ...extra };
  ctx.globalThis = ctx;
  return ctx;
}

// Page tool: onClick(el, document) lets a test change the page the way Southwest does.
async function runPage(name, html, path, input = {}, { onClick = () => {}, tools = [] } = {}) {
  const document = dom(html);
  document.modelContext = { getTools: async () => tools.map((t) => ({ name: `custom.ct_x.${t}` })) };
  const proto = Object.getPrototypeOf(document.body);
  const clicks = [];
  proto.click = function () { clicks.push(this); onClick(this, document); };
  proto.dispatchEvent = function () { return true; };
  const [tool] = runInNewContext(`(${load(name)})`, context(document, path));
  const out = await tool.execute(input);
  return { out: plain(out), document, clicks };
}

const fareButton = (name, price, orig) => `<div class="fare-button"><button class="fare-button--button" aria-label="${name}${orig ? `, original fare was dollars ${orig}, but now is ` : ""} fare $${price}, earn 1 points with this purchase."></button></div>`;
const card = (name, benefits, state) => `<div class="air-booking-vertical-fare-detail"><span>${name}</span><ul>${benefits.map((b) => `<li>${b}2</li>`).join("")}</ul><button class="air-booking-vertical-fare-detail--${state === "Selected" ? "selected-button" : "action-button"}"> ${state}</button></div>`;
const PANEL = (sel) => card("Basic", ["Last to board", "Checked bag fees"], sel === "Basic" ? "Selected" : "Select")
  + card("Choice", ["General boarding", "Checked bag fees"], sel === "Choice" ? "Selected" : "Upgrade")
  + card("Choice Preferred", ["Group 3-4 boarding", "Checked bag fees"], sel === "Choice Preferred" ? "Selected" : "Upgrade")
  + card("Choice Extra", ["Group 1 boarding", "Two free checked bags"], sel === "Choice Extra" ? "Selected" : "Upgrade")
  + `<button class="fare-detail--clear-flight" aria-label="Clear flight selection. Focus moves back to the available flight options.">Clear</button>`;
const row = (num, panel = "") => `<li class="air-booking-select-detail"><button class="flight-numbers--flight-number"><span class="actionable--text"># ${num}</span></button>`
  + `<div class="select-detail--time"><span class="time--value">Departs 6:30AM</span></div><div class="select-detail--time"><span class="time--value">Arrives 7:35AM</span></div>`
  + `<div class="select-detail--number-of-stops">Nonstop</div><div class="select-detail--flight-duration">1h 5m</div>`
  + fareButton("Basic", 114, 179) + fareButton("Choice", 153, 214) + fareButton("Choice Preferred", 223) + fareButton("Choice Extra", 266) + panel + `</li>`;
const results = (panel) => `<html><body><header><button>Log out</button></header><ul>${row("201", panel)}${row("3")}</ul><button class="search-results--continue-button">Select next flight</button></body></html>`;

test("southwest list_flight_results: rows, sale and regular fares, and the selected fare", async () => {
  const { out } = await runPage("list_flight_results", results(PANEL("Choice")), "/air/booking/select-depart.html");
  assert.equal(out.status, "ok");
  assert.equal(out.leg, "departing");
  assert.equal(out.result_count, 2);
  assert.deepEqual(out.results[0].flight_numbers, ["WN201"]);
  assert.deepEqual(out.results[0].fares[0], { fare_name: "Basic", price: 114, original_price: 179, available: true });
  assert.deepEqual(out.results[0].fares[2], { fare_name: "Choice Preferred", price: 223, original_price: null, available: true });
  assert.deepEqual(out.selected, { result_index: 0, fare_name: "Choice" });
  assert.equal((await runPage("list_flight_results", results(""), "/air/booking/price.html")).out.status, "wrong_page");
});

test("southwest get_page_context: page type, step, sign-in and missing passenger fields without values", async () => {
  const html = `<html><body><header><button>Log out</button></header><div>Price\nCompleted step,\nPassengers\nCurrent step,\n</div>`
    + `<input id="passengerFirstName-0" value="x"><input id="contactMethod" value="Text me"><input id="contactPhoneNumber"></body></html>`;
  const { out } = await runPage("get_page_context", html, "/air/booking/passenger.html", {}, { tools: ["continue_checkout", "get_trip_summary"] });
  assert.equal(out.page_type, "passenger");
  assert.equal(out.checkout_step, "Passengers");
  assert.equal(out.signed_in, true);
  assert.deepEqual(out.missing_required_fields, ["contactPhoneNumber"]);
  assert.ok(out.suggested_next_steps.some((s) => /user must type/.test(s)));
  assert.ok(!JSON.stringify(out).includes("Text me"));
});

// CDP select_fare: js() runs the page function against the fixture DOM; click() presses the marked element.
async function runFare(input, { selected = null, onPress = () => {}, path = "/air/booking/select-depart.html" } = {}) {
  let state = selected;
  const html = () => results(state === "none" ? "" : PANEL(state));
  let document = dom(html());
  const presses = [];
  const ctxBase = context(document, path);
  const helpers = {
    js: async (fn, opts) => runInNewContext(`(${fn.toString()})`, context(document, path))(opts?.arg),
    cdp: async () => ({}),
    waitForElement: async () => true,
    click: async (sel) => {
      const el = document.querySelector(sel);
      if (!el) throw Error("not found");
      presses.push(el.getAttribute("aria-label") || el.textContent.trim());
      state = onPress(el, state) ?? state;
      document = dom(html());
    }
  };
  const [tool] = runInNewContext(`(${load("select_fare")})`, { ...ctxBase, ...helpers });
  return { out: plain(await tool.execute(input)), presses };
}
const pick = (el) => (/(Basic|Choice Extra|Choice Preferred|Choice)\b/.exec(el.getAttribute("aria-label") || el.parentElement?.textContent || "") || [])[1];

test("southwest select_fare: guards before pressing anything", async () => {
  const base = { result_index: 0, expected_flight_numbers: ["WN201"] };
  let r = await runFare({ ...base, fare_name: "Basic" });
  assert.equal(r.out.status, "restrictions_not_accepted");
  assert.equal(r.presses.length, 0);
  r = await runFare({ ...base, expected_flight_numbers: ["WN3"], fare_name: "Choice" });
  assert.equal(r.out.status, "row_changed");
  r = await runFare({ ...base, fare_name: "Choice", expected_price: 150 });
  assert.equal(r.out.status, "price_changed");
  assert.equal(r.presses.length, 0);
  assert.equal((await runFare({ ...base, fare_name: "Choice" }, { path: "/air/booking/price.html" })).out.status, "wrong_page");
});

test("southwest select_fare: presses the fare once and returns benefits; idempotent and clear", async () => {
  const base = { result_index: 0, expected_flight_numbers: ["WN201"] };
  let r = await runFare({ ...base, fare_name: "Choice Extra", expected_price: 266 }, { selected: "none", onPress: (el) => pick(el) });
  assert.equal(r.out.status, "selected");
  assert.equal(r.out.selected_fare, "Choice Extra");
  assert.equal(r.presses.length, 1);
  assert.equal(r.out.options.find((o) => o.fare_name === "Choice Extra").checked_bags_free, true);
  assert.equal(r.out.options.find((o) => o.fare_name === "Basic").requires_accepting_restrictions, true);
  assert.equal(r.out.carry_on, "not_shown_on_page");
  r = await runFare({ ...base, fare_name: "Choice" }, { selected: "Choice" });
  assert.equal(r.out.status, "selected");
  assert.equal(r.presses.length, 0);
  r = await runFare({ ...base, clear: true }, { selected: "Choice", onPress: () => "none" });
  assert.equal(r.out.status, "cleared");
  assert.equal(r.out.selected_fare, null);
  r = await runFare({ ...base, fare_name: "Choice" }, { selected: "none", onPress: () => "none" });
  assert.equal(r.out.status, "error");
});

const priceHtml = `<html><body><header><button>Log out</button></header><div>\nTue 11/10\n# 201\n Opens flyout.\nDAL\nDeparts\n6:30 AM\nHOU\nArrives\n7:35 AM\n1 hr 5 minNonstop\n Opens flyout.\nChoice Preferred\n Opens flyout.\n`
  + `Thu 11/12\n# 1636\n Opens flyout.\nHOU\nDeparts\n6:00 AM\nDAL\nArrives\n7:05 AM\n1 hr 5 minNonstop\n Opens flyout.\nChoice\n Opens flyout.\n`
  + `Base fare1 Passenger(s)\t\n435.35 Dollars\n$435.35\nDiscount total\t-\n114.95 Dollars\n$114.95\nSubtotal\t\n320.40 Dollars\n$320.40\nTaxes and fees\t\n54.83 Dollars\n$54.83\n`
  + `Trip total\nSUBTOTAL\n435.35 Dollars\n$435.35\nTRIP TOTAL\n375.23 Dollars\n$375.23\n</div>`
  + `<button aria-label="Continue button. Redirects to passengers page">Continue</button></body></html>`;

test("southwest get_trip_summary: flights, fares and totals (TRIP TOTAL, not the Trip total heading)", async () => {
  const { out } = await runPage("get_trip_summary", priceHtml, "/air/booking/price.html");
  assert.equal(out.status, "ok");
  assert.equal(out.flights.length, 2);
  assert.deepEqual(out.flights[1], { date: "Thu 11/12", flight_numbers: ["WN1636"], from: "HOU", to: "DAL", departs: "6:00 AM", arrives: "7:05 AM", fare_name: "Choice" });
  assert.equal(out.trip_total, 375.23);
  assert.equal(out.taxes_and_fees, 54.83);
  assert.equal(out.discount, 114.95);
  const pay = await runPage("get_trip_summary", priceHtml.replace("</div>", "Seat 9C \nSeat selection skipped \n</div>"), "/air/booking/purchase.html");
  assert.deepEqual(pay.out.seats, ["9C", "skipped"]);
});

test("southwest continue_checkout: total, readiness and Purchase guards", async () => {
  let r = await runPage("continue_checkout", priceHtml, "/air/booking/price.html", {});
  assert.equal(r.out.status, "not_ready");
  r = await runPage("continue_checkout", priceHtml, "/air/booking/price.html", { expected_trip_total: 300 });
  assert.equal(r.out.status, "stale_state");
  assert.equal(r.clicks.length, 0);
  r = await runPage("continue_checkout", priceHtml, "/air/booking/price.html", { expected_trip_total: 375.23 });
  assert.equal(r.out.status, "navigation_scheduled");
  assert.equal(r.clicks.length, 1);
  r = await runPage("continue_checkout", priceHtml, "/air/booking/purchase.html", { expected_trip_total: 375.23 });
  assert.equal(r.out.status, "refused");
  assert.equal(r.clicks.length, 0);
  r = await runPage("continue_checkout", results(""), "/air/booking/select-depart.html", {});
  assert.equal(r.out.status, "not_ready");
  r = await runPage("continue_checkout", results(PANEL("Choice")), "/air/booking/select-depart.html", { expected_step: "select_depart" });
  assert.equal(r.out.status, "navigation_scheduled");
  assert.equal(r.out.pressed, "Select next flight");
  const passenger = `<html><body><input id="passengerFirstName-0" value="x"><input id="contactPhoneNumber"><button aria-label="Continue to seats button. Redirects to seats page.">Continue to seats</button></body></html>`;
  r = await runPage("continue_checkout", passenger, "/air/booking/passenger.html", {});
  assert.equal(r.out.status, "not_ready");
  assert.deepEqual(r.out.missing_required_fields, ["contactPhoneNumber"]);
  assert.equal(r.clicks.length, 0);
});

const seat = (id, price, kind, extra = "") => `<button id="${id}" aria-label="Seat ${id}  $${price}. (Chargeable, ${kind}, Aisle)${extra}" aria-pressed="false"></button>`;
const seatsHtml = (held = null, cta = "Next Flight") => `<html><body><button id="tabs-1-tab-0" aria-label="Flight 1 of 2 DAL to HOU 1 hours 5 minutes"></button><button id="tabs-1-tab-1" aria-label="Flight 2 of 2 HOU to DAL 1 hours 5 minutes"></button>`
  + `<button id="pax-button-1" aria-label="Pat Q. ${held ? "Seat: " + held : "No seat selected"}, checked"></button>`
  + seat("7D", 0, "Preferred") + seat("1C", 12, "Front cabin, Extra leg room") + seat("2D", 12, "Extra leg room", " unavailable")
  + `<div class="selectFlightFooterContainer"><div>Total seat upgrades: $0</div><div>Trip total: $375.23</div><button class="callToAction__x">${cta}</button></div></body></html>`;

test("southwest list_seat_map: seats, prices, availability, passengers by index only", async () => {
  const { out } = await runPage("list_seat_map", seatsHtml("7D"), "/air/seat/select-seats");
  assert.equal(out.status, "ok");
  assert.deepEqual(out.passengers, [{ passenger_index: 0, seat: "7D" }]);
  assert.deepEqual(out.seats.map((s) => s.seat_id), ["7D", "1C"]);
  assert.equal(out.seats[0].selected, true);
  assert.equal(out.seats[1].seat_type, "extra_legroom");
  assert.equal(out.trip_total, 375.23);
  assert.equal(out.next_control, "Next Flight");
  assert.ok(!JSON.stringify(out).includes("Pat"));
});

test("southwest select_seat: price guard, select via Southwest's Select button, remove", async () => {
  let r = await runPage("select_seat", seatsHtml(), "/air/seat/select-seats", { seat_id: "1C", expected_price: 0 });
  assert.equal(r.out.status, "price_changed");
  assert.equal(r.clicks.length, 0);
  r = await runPage("select_seat", seatsHtml(), "/air/seat/select-seats", { seat_id: "2D", expected_price: 12 });
  assert.equal(r.out.status, "not_available");
  const onClick = (el, doc) => {
    const footer = doc.querySelector(".callToAction__x");
    if (el.getAttribute("id") === "7D") footer.childNodes[0].data = "Select";
    else if (el === footer && footer.textContent === "Select") { doc.querySelector("#pax-button-1").setAttribute("aria-label", "Pat Q. Seat: 7D, checked"); footer.childNodes[0].data = "Next Flight"; }
  };
  r = await runPage("select_seat", seatsHtml(), "/air/seat/select-seats", { seat_id: "7D", expected_price: 0 }, { onClick });
  assert.equal(r.out.status, "selected");
  assert.equal(r.out.passenger_seat, "7D");
  r = await runPage("select_seat", seatsHtml("7D"), "/air/seat/select-seats", { seat_id: "7D", remove: true }, { onClick: (el, doc) => { if (el.getAttribute("id") === "7D") doc.querySelector("#pax-button-1").setAttribute("aria-label", "Pat Q. No seat selected, checked"); } });
  assert.equal(r.out.status, "removed");
  assert.equal(r.out.passenger_seat, null);
});

const payHtml = (opts = {}) => `<html><body><button id="payment-method-1" aria-label="Flex Pay pay monthly from $39.65 Information about Flex Pay." aria-expanded="false"></button>`
  + `<button id="payment-method-2" aria-label="PayPal/PayPal CreditBy choosing the PayPal option" aria-expanded="${opts.paypal ? "true" : "false"}"></button>`
  + `<button id="payment-method-3" aria-label="Credit/Debit. To pay with Credit/Debit, complete payment and billing information below."></button>`
  + (opts.paypal ? "" : `<input id="creditCardNumber">`)
  + `<button id="stacked-payments-2">Apply Flight Credits</button>`
  + `<input type="checkbox" id="creditCardDescriptionEnabled"${opts.save ? " checked" : ""}>`
  + `<input type="checkbox" aria-label="Keep me up to date using this email address"${opts.marketing ? " checked" : ""}>`
  + `<input type="radio" name="emailsDrawerRadioGroup" checked><input type="radio" name="emailsDrawerRadioGroup">`
  + `<div>Trip total\nSUBTOTAL\n435.35 Dollars\n$435.35\nTRIP TOTAL\n375.23 Dollars\n$375.23\n</div><button>Purchase</button></body></html>`;

test("southwest list_payment_methods: options, opt-ins and no personal data", async () => {
  const { out } = await runPage("list_payment_methods", payHtml({ marketing: true }), "/air/booking/purchase.html");
  assert.deepEqual(out.methods.map((m) => m.method), ["flex_pay", "paypal", "credit_debit"]);
  assert.equal(out.methods[0].label, "Flex Pay pay monthly from $39.65");
  assert.equal(out.selected_method, "credit_debit");
  assert.deepEqual(out.opt_ins, { save_card_to_account: false, marketing_email: true });
  assert.equal(out.receipt_email, "saved");
  assert.equal(out.trip_total, 375.23);
  assert.deepEqual(out.saved_cards, []);
});

test("southwest select_payment_method: total guard, switch, unchecks opt-ins, never presses Purchase", async () => {
  let r = await runPage("select_payment_method", payHtml(), "/air/booking/purchase.html", { method: "paypal", expected_trip_total: 300 });
  assert.equal(r.out.status, "stale_state");
  assert.equal(r.clicks.length, 0);
  const onClick = (el, doc) => {
    if (el.getAttribute("id") === "payment-method-2") { el.setAttribute("aria-expanded", "true"); doc.querySelector("#creditCardNumber")?.setAttribute("hidden", ""); }
    if (el.getAttribute("type") === "checkbox") el.checked = !el.checked;
  };
  r = await runPage("select_payment_method", payHtml({ marketing: true, save: true }), "/air/booking/purchase.html", { method: "paypal", expected_trip_total: 375.23 }, { onClick });
  assert.equal(r.out.status, "selected");
  assert.equal(r.out.selected_method, "paypal");
  assert.deepEqual(r.out.opt_ins, { save_card_to_account: false, marketing_email: false });
  assert.ok(r.clicks.every((c) => !/Purchase/.test(c.textContent)));
  r = await runPage("select_payment_method", payHtml(), "/air/booking/purchase.html", { method: "flex_pay", expected_trip_total: 375.23 });
  assert.equal(r.out.status, "invalid_input");
});

test("southwest select_fare: retries once when the first press is swallowed, never more", async () => {
  const base = { result_index: 0, expected_flight_numbers: ["WN201"], fare_name: "Choice" };
  let n = 0;
  let r = await runFare(base, { selected: "none", onPress: (el) => (++n === 1 ? "none" : pick(el)) });
  assert.equal(r.out.status, "selected");
  assert.equal(r.presses.length, 2);
  r = await runFare(base, { selected: "none", onPress: () => "none" });
  assert.equal(r.out.status, "error");
  assert.equal(r.presses.length, 2);
});

test("southwest get_page_context: reports navigating after continue_checkout until the document changes", async () => {
  const document = dom(results(PANEL("Choice")));
  const proto = Object.getPrototypeOf(document.body);
  proto.click = () => {};
  const ctx = context(document, "/air/booking/select-depart.html");
  const [cont] = runInNewContext(`(${load("continue_checkout")})`, ctx);
  assert.equal((await cont.execute({})).status, "navigation_scheduled");
  const [pc] = runInNewContext(`(${load("get_page_context")})`, ctx);
  const out = plain(await pc.execute({}));
  assert.equal(out.unsettled, true);
  assert.ok(out.unsettled_reasons.includes("navigating"));
  assert.ok(/do not press continue again/.test(out.suggested_next_steps[0]));
});
