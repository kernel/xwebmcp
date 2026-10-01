import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { Document } from "./etsy-dom.mjs";

const load = name => readFileSync(new URL(`../domains/united.com/${name}.js`, import.meta.url), "utf8");
const plain = v => JSON.parse(JSON.stringify(v));

function run(name, html, input = {}, { url = "https://www.united.com/en/us/fsr/choose-flights?f=CVG&t=ORD&d=2026-10-07&r=2026-10-08&tqp=R", onClick = () => {}, tools = [] } = {}) {
  const document = new Document(html);
  document.modelContext = { getTools: async () => tools.map(t => ({ name: `custom.ct_x.${t}` })) };
  const proto = Object.getPrototypeOf(document.body);
  proto.click = function () { onClick(this, document); };
  if (!Object.getOwnPropertyDescriptor(proto, "checked")) Object.defineProperty(proto, "checked", { get() { return this.hasAttribute("checked"); }, set(v) { v ? this.setAttribute("checked", "") : this.removeAttribute("checked"); }, configurable: true });
  const u = new URL(url);
  const scheduled = [];
  const context = { document, navigator: {}, URL, JSON, Number, Math, Date, Infinity, location: { href: u.href, pathname: u.pathname, search: u.search },
    setTimeout: (fn, ms) => { if (ms === 100) { scheduled.push(fn); return 0; } setImmediate(fn); return 0; } };
  const [tool] = runInNewContext(`(${load(name)})`, context);
  return tool.execute(input).then(out => ({ out: plain(out), document, scheduled }));
}

const headers = `<button aria-label="Link. Select to sort results by United Economy Main cabin">United Economy® (Main cabin)</button><button aria-label="Link. Select to sort results by Economy Plus">Economy Plus® (Extra legroom)</button>`;
const row = (dep, arr, num, price1, price2) => `<div class="wrap"><div class="app-Flight-styles__flightContainer--x">NONSTOP ${dep} Departing at ${dep} ${arr} Arriving at ${arr} CVG Origin Cincinnati, OH, US (CVG) 1H, 29M Duration 1 hours and 29 minutes ORD Destination Chicago, IL, US (ORD) ${num} (Boeing 737-800) Flight Number</div>
  <button class="PriceCard">From $${price1} United Economy cabin select to view fare options</button><button class="PriceCard">From $${price2} United Economy cabin select to view fare options</button></div>`;
const results = (leg = "DEPART ON: October 7", drawer = "") => `<html><body><h2>${leg}</h2>${headers}${row("7:00 AM", "7:34 AM", "UA 2752", 512, 625)}${row("5:30 AM", "5:59 AM", "UA 1379", 512, 625)}${drawer}</body></html>`;
const card = (name, price, carry, consent) => `<div class="card"><div>United Economy®</div><div>${name}</div><div>From</div><div>$${price}</div><div>Fare includes</div><div>Non-refundable</div><div>${carry}</div>${consent ? '<input type="checkbox" id="be"><label for="be">Basic Economy works for me.</label>' : ""}<div>717 MileagePlus miles</div><button aria-label="Select United Economy ${name}">Select</button></div>`;
const drawer = card("Basic (Most restrictive)", 512, "No carry-on bags3", true) + card("Standard", 543, "1 carry-on bag included", false);

test("united list_flight_results: rows with flight numbers, header-named cabin columns, departure sort", async () => {
  const { out } = await run("list_flight_results", results(), { sort_by: "departure" });
  assert.equal(out.status, "ok");
  assert.equal(out.leg, "departing");
  assert.deepEqual(out.flights.map(f => f.flight_numbers[0]), ["UA 1379", "UA 2752"]);
  const f = out.flights[0];
  assert.equal(f.result_index, 1);
  assert.equal(f.origin, "CVG");
  assert.equal(f.destination, "ORD");
  assert.equal(f.duration_minutes, 89);
  assert.equal(f.stops, 0);
  assert.deepEqual(f.cabins.map(c => [c.cabin, c.from_price]), [["United Economy (Main cabin)", 512], ["Economy Plus (Extra legroom)", 625]]);
  assert.equal((await run("list_flight_results", results("RETURN ON: October 8"))).out.leg, "returning");
});

test("united select_fare: opens options with price, carry-on and the Basic consent flag", async () => {
  const { out } = await run("select_fare", results(), { result_index: 1, cabin_index: 0, expected_flight_numbers: ["UA 1379"] }, {
    onClick: (el, doc) => { if (/fare options/.test(el.textContent || "")) { const holder = new Document(`<div>${drawer}</div>`).root.children[0]; doc.body.childNodes.push(holder); holder.parentNode = doc.body; } }
  });
  assert.equal(out.status, "fare_choice_required");
  assert.deepEqual(out.options.map(o => [o.fare_name, o.price, o.carry_on_included, o.requires_accepting_restrictions]), [["Basic (Most restrictive)", 512, false, true], ["Standard", 543, true, false]]);
  assert.equal((await run("select_fare", results(), { result_index: 1, cabin_index: 0, expected_flight_numbers: ["UA 9"] })).out.status, "row_changed");
});

test("united select_fare_option: Basic needs consent; departing Standard waits for the return list", async () => {
  const refused = await run("select_fare_option", results("DEPART ON: October 7", drawer), { fare_name: "Basic" });
  assert.equal(refused.out.status, "consent_required");
  assert.equal(refused.document.getElementById("be").checked, false);
  const clicks = [];
  const { out } = await run("select_fare_option", results("DEPART ON: October 7", drawer), { fare_name: "Standard" }, {
    onClick: (el, doc) => { clicks.push(el.getAttribute("aria-label")); doc.querySelector("h2").childNodes[0].data = "RETURN ON: October 8"; }
  });
  assert.equal(out.status, "selected");
  assert.equal(out.next_page, "return_results");
  assert.deepEqual(clicks, ["Select United Economy Standard"]);
  const consented = await run("select_fare_option", results("RETURN ON: October 8", drawer), { fare_name: "Basic", accept_restrictions: true }, {
    onClick: (el, doc) => { if (el.tagName === "LABEL") doc.getElementById("be").checked = true; }
  });
  assert.equal(consented.out.next_page, "checkout");
  assert.equal(consented.out.restrictions_accepted, true);
  assert.equal(consented.scheduled.length, 1, "final selection is scheduled after settling");
  assert.equal((await run("select_fare_option", results("DEPART ON: October 7", drawer), { fare_name: "Polaris" })).out.status, "fare_not_offered");
});

const cart = `<html><body><h2>Traveler 1: Jane Example</h2><div>Date of birth: 01/01/1990</div>
  <div class="cart"><h2>ROUNDTRIP (1 TRAVELER)</h2><div>Flight 1 of 2</div><div>Cincinnati CVG to Chicago ORD</div><div>Wednesday, October 7</div><div>5:30 am to 5:59 amNonstop</div><button>Show details</button><div>Duration: 1h 29m</div><div>Flight Number: UA 1379</div><div>Aircraft type: Boeing 737-800</div>
  <div>Flight 2 of 2</div><div>Chicago ORD to Cincinnati CVG</div><div>Thursday, October 8</div><div>6:55 am to 9:20 amNonstop</div><div>Flight Number: UA 1970</div>
  <div>Price breakdown</div><div>Fare</div><div>$476.28</div><div>$476.28/person</div><div>Taxes and fees</div><div>$66.52</div><div>Total due</div><div>$542.80</div><div>Cart ID: 745157443</div></div></body></html>`;

test("united get_trip_summary: flights, totals and cart id; never traveler details", async () => {
  const { out } = await run("get_trip_summary", cart, {}, { url: "https://www.united.com/en/us/traveler/choose-travelers?cartId=SECRET" });
  assert.equal(out.status, "ok");
  assert.equal(out.trip_type, "ROUNDTRIP");
  assert.equal(out.travelers, 1);
  assert.deepEqual(out.flights.map(f => [f.origin, f.destination, f.departure_time, f.stops, f.flight_numbers[0]]), [["CVG", "ORD", "5:30 am", 0, "UA 1379"], ["ORD", "CVG", "6:55 am", 0, "UA 1970"]]);
  assert.equal(out.fare_per_person, 476.28);
  assert.equal(out.taxes_and_fees, 66.52);
  assert.equal(out.total_due, 542.8);
  assert.equal(out.cart_id, "745157443");
  const serialized = JSON.stringify(out);
  assert.ok(!/Jane|Example|1990|SECRET/.test(serialized), "no traveler data or raw cartId URL");
});

test("united get_page_context: signed-in status, results leg, verification step", async () => {
  const signedIn = `<html><body><header><span>Hi, JE</span><span>Premier Silver</span></header><h2>RETURN ON: October 8</h2></body></html>`;
  const r = await run("get_page_context", signedIn, {}, { tools: ["list_flight_results", "select_fare"] });
  assert.equal(r.out.page_type, "flight_results");
  assert.equal(r.out.results_leg, "returning");
  assert.equal(r.out.signed_in, true);
  assert.equal(r.out.member_status, "Premier Silver");
  const mfa = `<html><body><header><button>Sign in</button></header>${[1, 2, 3, 4, 5, 6].map(i => `<input type="text" aria-label="Enter code Enter digit ${i} of 6">`).join("")}</body></html>`;
  const m = await run("get_page_context", mfa, {}, { url: "https://www.united.com/en/us/united-mileageplus-signin", tools: ["login"] });
  assert.equal(m.out.page_type, "sign_in");
  assert.equal(m.out.verification_code_requested, true);
  assert.ok(m.out.suggested_next_steps[0].includes("verification code"));
});
