import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { Document } from "./etsy-dom.mjs";

const load = name => readFileSync(new URL(`../domains/google.com/${name}.js`, import.meta.url), "utf8");
const plain = v => JSON.parse(JSON.stringify(v));

function run(name, html, input = {}, { url, onClick = () => {}, tools = [] } = {}) {
  const document = new Document(html);
  document.modelContext = { getTools: async () => tools.map(t => ({ name: `custom.ct_x.${t}` })) };
  const proto = Object.getPrototypeOf(document.body);
  proto.click = function () { onClick(this, document, location); };
  const u = new URL(url);
  const location = { href: u.href, pathname: u.pathname, search: u.search };
  const context = { document, navigator: {}, URL, JSON, Number, Math, Date, Infinity, atob, location, setTimeout: fn => setImmediate(fn) };
  const [tool] = runInNewContext(`(${load(name)})`, context);
  return tool.execute(input).then(out => ({ out: plain(out), document, location }));
}

const row = (aria, route) => `<li><div role="link" aria-label="${aria}">x</div><span>${route}</span><div role="button" aria-label="0 carry-on bags included. 0 checked bags included. Learn more">bags</div></li>`;
const dep = (time, arr, route = "CVG–ORD") => row(`From 512 US dollars round trip total. Nonstop flight with United. Leaves Cincinnati/Northern Kentucky International Airport at ${time} on Wednesday, October 7 and arrives at Chicago O'Hare International Airport at ${arr} on Wednesday, October 7. Total duration 1 hr 29 min. Select flight`, route);
const resultsUrl = "https://www.google.com/travel/flights/search?tfs=x";

const departing = `<html><body><h3>Top departing flights</h3><ul>${dep("7:00 AM", "7:34 AM")}${dep("5:30 AM", "5:59 AM")}
  ${row("From 443 US dollars round trip total. 1 stop flight with Frontier. Leaves Cincinnati/Northern Kentucky International Airport at 12:43 PM on Wednesday, October 7 and arrives at Chicago O'Hare International Airport at 6:23 PM on Wednesday, October 7. Total duration 5 hr 40 min. Layover (1 of 1) is a 2 hr 50 min layover at Denver International Airport in Denver. Select flight", "CVG–ORD")}</ul></body></html>`;

test("google list_flights: parses rows, bags, route codes; sorts by departure; filters airline and stops", async () => {
  const { out } = await run("list_flights", departing, { sort_by: "departure" }, { url: resultsUrl });
  assert.equal(out.status, "ok");
  assert.equal(out.leg, "departing");
  assert.equal(out.total_rows, 3);
  assert.deepEqual(out.flights.map(f => f.departure_time), ["5:30 AM", "7:00 AM", "12:43 PM"]);
  const first = out.flights[0];
  assert.equal(first.result_index, 1);
  assert.deepEqual(first.airlines, ["United"]);
  assert.equal(first.origin, "CVG");
  assert.equal(first.destination, "ORD");
  assert.equal(first.duration_minutes, 89);
  assert.deepEqual(first.price, { amount: 512, currency_label: "US dollars", scope: "round_trip_total" });
  assert.equal(first.carry_on_bags, 0);
  assert.equal(out.flights[2].stops, 1);
  assert.deepEqual(out.flights[2].layovers, ["2 hr 50 min layover at Denver International Airport in Denver"]);
  const united = await run("list_flights", departing, { airline: "United", max_stops: 0 }, { url: resultsUrl });
  assert.equal(united.out.flights.length, 2);
});

test("google select_flight: refuses a changed row; reports returning flights after the click", async () => {
  const changed = await run("select_flight", departing, { result_index: 0, expected_departure_time: "5:30 AM" }, { url: resultsUrl });
  assert.equal(changed.out.status, "row_changed");
  const { out } = await run("select_flight", departing, { result_index: 1, expected_departure_time: "5:30 AM", expected_airline: "United" }, {
    url: resultsUrl,
    onClick: (el, doc, loc) => { loc.href = resultsUrl + "&step=2"; const h = doc.querySelector("h3"); h.childNodes[0].data = "Top returning flights"; }
  });
  assert.equal(out.status, "selected");
  assert.equal(out.next_page, "returning_flights");
});

const booking = `<html><body>
  <div aria-label="Departing flight on Wednesday, October 7. Leaves Cincinnati/Northern Kentucky International Airport at 5:30 AM on Wednesday, October 7 and arrives at Chicago O'Hare International Airport at 5:59 AM.">d</div>
  <div><div>Basic Economy</div><div>$512</div><div>Seat selection for a fee</div><div>No carry-on bags</div><div>First checked bag costs 100 US dollars</div><button aria-label="Continue to book with United, Basic Economy for 512 US dollars">Continue</button></div>
  <div><div>Economy</div><div>$543</div><div>Free seat selection</div><div>1 free carry-on</div><div>First checked bag costs 100 US dollars</div><button aria-label="Continue to book with United, Economy for 543 US dollars">Continue</button></div>
</body></html>`;

test("google get_booking_options: each fare with price and carry-on inclusion", async () => {
  const { out } = await run("get_booking_options", booking, {}, { url: "https://www.google.com/travel/flights/booking?tfs=x" });
  assert.equal(out.status, "ok");
  assert.deepEqual(out.options.map(o => [o.seller, o.fare_name, o.price, o.carry_on_included]), [["United", "Basic Economy", 512, false], ["United", "Economy", 543, true]]);
  assert.equal(out.selected_flights.length, 1);
});

test("google get_page_context: page types and booking suggestions", async () => {
  const b = await run("get_page_context", booking, {}, { url: "https://www.google.com/travel/flights/booking?tfs=x", tools: ["get_booking_options", "continue_to_airline", "get_page_context"] });
  assert.equal(b.out.page_type, "booking_options");
  assert.ok(b.out.suggested_next_steps.some(s => s.includes("continue_to_airline")));
  const r = await run("get_page_context", departing.replace("Top departing", "Top returning"), {}, { url: resultsUrl, tools: ["list_flights"] });
  assert.equal(r.out.page_type, "returning_results");
});
