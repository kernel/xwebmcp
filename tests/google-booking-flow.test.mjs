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

test("google select_flight accepts search_flights' 24-hour times", async () => {
  const { out } = await run("select_flight", departing, { result_index: 1, expected_departure_time: "05:30" }, { url: resultsUrl, onClick: () => {} });
  assert.equal(out.status, "selected");
  const wrong = await run("select_flight", departing, { result_index: 1, expected_departure_time: "07:00" }, { url: resultsUrl });
  assert.equal(wrong.out.status, "row_changed");
});

const oneWayUrl = "https://www.google.com/travel/flights/search?tfs=" + btoa("\x1a\x1e\x12\x0a2026-11-12j\x07\x08\x01\x12\x03JFKr\x07\x08\x01\x12\x03LAX").replace(/=+$/, "");
const oneWayRow = (price, time, airline) => row(`From ${price} US dollars. Nonstop flight with ${airline}. Leaves John F. Kennedy International Airport at ${time} on Thursday, November 12 and arrives at Los Angeles International Airport at 3:14 PM on Thursday, November 12. Total duration 6 hr 14 min. Select flight`, "JFK–LAX");
const oneWayPage = `<html><body><h3>Top flights</h3><ul>${oneWayRow("259", "6:00 AM", "Delta")}${oneWayRow("204", "12:00 PM", "JetBlue")}
  <li><div role="link" aria-label="Total price is unavailable. Nonstop flight with Alaska. Leaves John F. Kennedy International Airport at 7:00 AM on Thursday, November 12 and arrives at Los Angeles International Airport at 10:30 AM on Thursday, November 12. Total duration 6 hr 30 min. Select flight">x</div></li>
  ${oneWayRow("1,204", "9:00 AM", "United")}</ul></body></html>`;

test("google list_flights: one-way prices are read and price sorting puts unpriced rows last", async () => {
  const { out } = await run("list_flights", oneWayPage, { sort_by: "price" }, { url: oneWayUrl });
  assert.equal(out.status, "ok");
  assert.deepEqual(out.flights.map(f => f.price?.amount ?? null), [204, 259, 1204, null]);
  assert.deepEqual(out.flights[0].price, { amount: 204, currency_label: "US dollars", scope: "one_way" });
});

test("google select_flight: expected_airline matches the carriers only, and invalid 24-hour times are refused", async () => {
  let clicks = 0;
  const airport = await run("select_flight", oneWayPage, { result_index: 1, expected_departure_time: "12:00 PM", expected_airline: "Kennedy" }, { url: oneWayUrl, onClick: () => clicks++ });
  assert.equal(airport.out.status, "row_changed");
  const time = await run("select_flight", oneWayPage, { result_index: 1, expected_departure_time: "25:00" }, { url: oneWayUrl, onClick: () => clicks++ });
  assert.equal(time.out.status, "error");
  const index = await run("select_flight", oneWayPage, { result_index: -1 }, { url: oneWayUrl, onClick: () => clicks++ });
  assert.equal(index.out.status, "error");
  assert.equal(clicks, 0);
});

const option = (label, lines = [], hidden = false) => `<div${hidden ? " hidden" : ""}>${lines.map(l => `<span>${l}</span>`).join("")}<button aria-label="${label}">Continue</button></div>`;
const sellers = `<html><body>
  <div aria-label="Departing flight on Friday, November 20. Leaves John F. Kennedy International Airport at 8:05 AM on Friday, November 20 and arrives at Heathrow Airport at 8:00 PM.">d</div>
  <div><span>1 free carry-on</span></div><div><span>1st checked bag available for a fee</span></div>
  <h2>Booking options</h2>
  ${option("Continue to book with Frontier, Basic Fare for 106 US dollars", ["Basic Fare", "$106", "Seat selection for a fee", "1 carry-on bag available for a fee", "1st checked bag available for a fee"])}
  ${option("Continue to book with Frontier, Economy Bundle for 141 US dollars", ["Economy Bundle", "$141", "Free seat selection", "1st checked bag available for a fee"]).replace("</span><button", "</span><ul><li><span></span>1 free carry-on</li></ul><button")}
  ${option("Continue to book with British Airways airline for 422 US dollars", ["Book with British Airways", "Airline", "$422", "View options"])}
  ${option("Continue to book with Booking.com for 409 US dollars", ["Book with Booking.com", "$409"])}
  ${option("Continue to book with Southwest, United airline for 381 US dollars. The 2 tickets in your itinerary must be booked individually", ["Book with Southwest, United", "$381"])}
  <div hidden>${option("Continue to book with ly.com for 400 US dollars", ["Book with ly.com", "$400"])}${option("Continue to book with Expedia for 422 US dollars", ["Book with Expedia", "$422"])}</div>
  <button aria-label="2 more booking options">more</button>
</body></html>`;

test("google get_booking_options: airline, agency, separate-ticket and collapsed sellers; paid carry-ons are not included", async () => {
  const { out } = await run("get_booking_options", sellers, {}, { url: "https://www.google.com/travel/flights/booking?tfs=x" });
  assert.equal(out.status, "ok");
  assert.deepEqual(out.options.map(o => [o.seller, o.fare_name, o.price, o.sold_by_airline, o.separate_tickets, o.collapsed]), [
    ["Frontier", "Basic Fare", 106, true, false, false],
    ["Frontier", "Economy Bundle", 141, true, false, false],
    ["British Airways", null, 422, true, false, false],
    ["Booking.com", null, 409, false, false, false],
    ["Southwest, United", null, 381, true, true, false],
    ["ly.com", null, 400, false, false, true],
    ["Expedia", null, 422, false, false, true],
  ]);
  assert.deepEqual(out.options.map(o => o.currency_label), Array(7).fill("US dollars"));
  assert.equal(out.options[4].note, "The 2 tickets in your itinerary must be booked individually");
  assert.deepEqual(out.options.slice(0, 2).map(o => [o.carry_on, o.carry_on_included]), [["1 carry-on bag available for a fee", false], ["1 free carry-on", true]]);
  assert.deepEqual(out.options[0].features, ["Seat selection for a fee"]);
  assert.deepEqual(out.options[2].features, []);
  assert.deepEqual(out.bag_info, ["1 free carry-on", "1st checked bag available for a fee"]);
});

function continueTool(html) {
  const document = new Document(html);
  const location = { pathname: "/travel/flights/booking" };
  const labelOf = selector => selector.match(/^button\[aria-label(\$?)="(.*)"\]$/);
  const find = selector => {
    const [, suffix, label] = labelOf(selector);
    return document.querySelectorAll("button").filter(b => suffix ? b.getAttribute("aria-label").endsWith(label) : b.getAttribute("aria-label") === label.replace(/\\"/g, "\""));
  };
  const clicks = [];
  const [tool] = runInNewContext(`(${load("continue_to_airline")})`, {
    js: async (fn, options) => runInNewContext(`(${fn.toString()})`, { document, location })(options.arg),
    waitForElement: async selector => find(selector).some(b => b.getClientRects().length > 0),
    click: async selector => {
      const [button] = find(selector);
      clicks.push(button.getAttribute("aria-label"));
      if (/more booking options$/.test(button.getAttribute("aria-label"))) for (const e of document.querySelectorAll("[hidden]")) e.removeAttribute("hidden");
    },
    currentTab: async () => ({ targetId: "booking" }),
    switchTab: async () => {},
    cdp: async method => method === "Page.bringToFront" ? {} : ({ targetInfos: clicks.some(c => c.startsWith("Continue")) ? [{ targetId: "new", type: "page", url: "https://www.example-airline.test/cart" }] : [] }),
    waitMs: async () => {},
    URL
  });
  return { execute: async input => plain(await tool.execute(input)), clicks };
}

test("google continue_to_airline: sellers without fares, collapsed options, and fare ambiguity", async () => {
  const ba = continueTool(sellers);
  const opened = await ba.execute({ seller: "British Airways", expected_price: 422 });
  assert.equal(opened.status, "opened");
  assert.deepEqual([opened.seller, opened.fare_name, opened.price], ["British Airways", null, 422]);
  assert.deepEqual(ba.clicks, ["Continue to book with British Airways airline for 422 US dollars"]);

  const ly = continueTool(sellers);
  assert.equal((await ly.execute({ seller: "ly.com", fare_name: null })).status, "opened");
  assert.deepEqual(ly.clicks, ["2 more booking options", "Continue to book with ly.com for 400 US dollars"]);

  const frontier = continueTool(sellers);
  const ambiguous = await frontier.execute({ seller: "Frontier" });
  assert.equal(ambiguous.status, "not_found");
  assert.match(ambiguous.error_message, /pass fare_name/);
  assert.equal((await frontier.execute({ seller: "Frontier", fare_name: "Economy Bundle", expected_price: 100 })).status, "price_changed");
  assert.equal((await frontier.execute({ seller: "Frontier", fare_name: "Economy Bundle", expected_price: 141 })).status, "opened");
  assert.deepEqual(frontier.clicks, ["Continue to book with Frontier, Economy Bundle for 141 US dollars"]);
});
