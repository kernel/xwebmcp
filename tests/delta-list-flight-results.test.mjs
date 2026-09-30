import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { Document } from "./etsy-dom.mjs";

const source = readFileSync(new URL("../domains/delta.com/list_flight_results.js", import.meta.url), "utf8");
const key = "fabricated-key";
const url = `https://www.delta.com/flightsearch/search-results?cacheKeySuffix=${key}`;

// Fabricated rows in Delta's desktop results markup (ids, data-testids, classes as observed).
const fare = (row, code, { brands = [], amount, left, soldOut } = {}) => `
  <idp-fare-cell-desktop><div id="grid-row-${row}-fare-cell-desktop-${code}" class="fare-cell-desktop fare-cell-desktop-${code}">
    ${brands.map(b => `<span class="brand-name">${b}</span>`).join("")}
    ${amount ? `<idp-fare-cell-revenue-template><span class="currency-symbol">$</span><span class="rounded-amount">${amount}</span></idp-fare-cell-revenue-template><idp-fare-cell-desktop-template>$${amount} One-Way${left ? ` ${left} left at this price` : ""}</idp-fare-cell-desktop-template>` : ""}
    ${soldOut ? "<span>Sold Out</span>" : ""}
  </div></idp-fare-cell-desktop>`;
const row = (i, { numbers, dep, arr, dayChange = "", duration, stops = 1, fares, broken = false, hidden = false }) => `
  <div id="flight-results-grid-${i}"${hidden ? " hidden" : ""}>
    <idp-mach-core-flight-card>
      ${numbers.map((n, j) => `<a data-testid="flight-card-header-segment-link-${j}">${n}</a>`).join("")}
      <span data-testid="flight-card-header-duration">${duration}</span>
      <idp-mach-core-flight-card-layover>
        <span data-testid="flight-card-layover-origin">CVG</span>
        <span data-testid="flight-card-layover-destination">SFO</span>
        ${broken ? "" : `<span data-testid="flight-card-layover-departure-time">${dep}</span>`}
        <span data-testid="flight-card-layover-arrival-time">${arr}</span>
        ${dayChange ? `<span data-testid="flight-card-layover-day-change">${dayChange}</span>` : ""}
        ${Array.from({ length: stops }, (_, k) => `<span data-testid="flight-card-layover-stop-${k}">ATL</span>`).join("")}
      </idp-mach-core-flight-card-layover>
    </idp-mach-core-flight-card>
    ${fares}
  </div>`;
const headers = `<idp-flight-cabin-header-wrapper id="mach-cabin-header"><span id="mach-cabin-header-desktop-BMAIN">Main</span><span id="mach-cabin-header-desktop-BDCP">Comfort</span></idp-flight-cabin-header-wrapper>`;
const page = (rowsHtml, extra = "") => `<html><head><title>Flight Results</title></head><body>${headers}<idp-search-results>${rowsHtml}</idp-search-results>${extra}</body></html>`;

const standard = page(
  row(0, { numbers: ["DL2441", "DL693"], dep: "2:08 pm", arr: "6:09 pm", duration: "7h 1m", fares: fare(0, "BMAIN", { brands: ["Delta Main"], amount: "399", left: 1 }) + fare(0, "BDCP", { soldOut: true }) }) +
  row(1, { numbers: ["DL393"], dep: "6:00 am", arr: "10:21 am", duration: "7h 21m", stops: 0, fares: fare(1, "BMAIN", { brands: ["Delta Main"], amount: "459" }) + fare(1, "CDCP", { brands: ["Delta Main,", "Delta Comfort"], amount: "1,554", left: 2 }) }) +
  row(2, { numbers: ["DL703", "DL2089"], dep: "7:47 pm", arr: "12:02 am", dayChange: "+1 day", duration: "7h 15m", fares: fare(2, "BMAIN", { brands: ["Delta Main"], amount: "389" }) }) +
  row(3, { numbers: ["DL5"], dep: "9:00 am", arr: "1:00 pm", duration: "7h", broken: true, fares: fare(3, "BMAIN", { brands: ["Delta Main"], amount: "100" }) }) +
  row(4, { numbers: ["DL6"], dep: "5:00 am", arr: "9:00 am", duration: "7h", hidden: true, fares: fare(4, "BMAIN", { brands: ["Delta Main"], amount: "1" }) })
);

function run(html, input = {}, { storage = { tripType: "ONE_WAY", segments: [{ origin: "CVG", destination: "SFO", departureDate: "2026-10-20" }], passengers: [{ count: "1", type: "ADT" }] } } = {}) {
  const document = new Document(html);
  const context = {
    document, URL, JSON, Number, Math, Infinity,
    location: { href: url },
    localStorage: { getItem: k => (k === "postData" + key && storage ? JSON.stringify(storage) : null) },
    getComputedStyle: () => ({ visibility: "visible" }),
    setTimeout: fn => setImmediate(fn),
    Date
  };
  const [tool] = runInNewContext(`(${source})`, context);
  return tool.execute(input).then(out => JSON.parse(JSON.stringify(out)));
}

test("lists every visible row with all fare columns and the stored search", async () => {
  const out = await run(standard);
  assert.equal(out.status, "ok");
  assert.deepEqual(out.search, { origin: "CVG", destination: "SFO", depart_date: "2026-10-20", return_date: null, trip_type: "one_way", adults: 1 });
  assert.equal(out.total_rows, 4, "hidden row excluded");
  assert.equal(out.skipped_rows, 1, "row without a departure time is skipped, not guessed");
  assert.deepEqual(out.flights.map(f => f.result_index), [0, 1, 2]);
  const [first, second] = out.flights;
  assert.deepEqual(first.flight_numbers, ["DL 2441", "DL 693"]);
  assert.equal(first.departure_time, "2:08 PM");
  assert.deepEqual(first.fares[1], { brand_code: "BDCP", cabin: "Comfort", brand_name: null, amount: null, currency_display: null, basis_display: null, seats_left: null, sold_out: true });
  assert.equal(first.fares[0].seats_left, 1);
  assert.equal(first.fares[0].cabin, "Main");
  assert.equal(out.more_results_available, false);
  assert.equal(second.stops, 0);
  assert.equal(second.fares[1].brand_name, "Delta Main, Delta Comfort");
  assert.equal(second.fares[1].amount, 1554);
  assert.deepEqual(second.lowest_fare, { brand_code: "BMAIN", brand_name: "Delta Main", amount: 459, currency_display: "$" });
});

test("sorts by departure, arrival (with +1 day), price and duration; filters and limits", async () => {
  assert.deepEqual((await run(standard, { sort_by: "departure" })).flights.map(f => f.result_index), [1, 0, 2]);
  assert.deepEqual((await run(standard, { sort_by: "arrival" })).flights.map(f => f.result_index), [1, 0, 2], "12:02 am +1 day sorts last");
  assert.deepEqual((await run(standard, { sort_by: "price" })).flights.map(f => f.result_index), [2, 0, 1]);
  assert.deepEqual((await run(standard, { sort_by: "duration" })).flights.map(f => f.result_index), [0, 2, 1]);
  assert.deepEqual((await run(standard, { max_stops: 0 })).flights.map(f => f.result_index), [1]);
  const limited = await run(standard, { sort_by: "departure", limit: 1 });
  assert.equal(limited.flights.length, 1);
  assert.equal(limited.total_rows, 4);
});

test("site error is an error, not zero flights", async () => {
  const out = await run(page("", '<idp-adv-search-error-message>We are unable to process your request. #SFAF001_429</idp-adv-search-error-message>'));
  assert.equal(out.status, "error");
  assert.match(out.error_message, /SITE_ERROR: .*SFAF001_429/);
});

test("still-loading page returns not_ready, not a partial list", async () => {
  const out = await run(page("<idp-flight-row-skeleton>loading</idp-flight-row-skeleton>"), { wait_seconds: 0 });
  assert.equal(out.status, "not_ready");
});

test("explicit empty state returns no_results; missing search record gives search null", async () => {
  const out = await run(page("<p>No flights were found for your search.</p>"), { wait_seconds: 0 }, { storage: null });
  assert.equal(out.status, "no_results");
  assert.equal(out.search, null);
  assert.deepEqual(out.flights, []);
});

test("reports See More Results and loads more rows only when asked", async () => {
  const more = page(row(0, { numbers: ["DL1"], dep: "9:00 am", arr: "1:00 pm", duration: "7h", fares: fare(0, "BMAIN", { brands: ["Delta Main"], amount: "300" }) }), '<button class="see-more-button">See More Results</button>');
  const plainRun = await run(more);
  assert.equal(plainRun.more_results_available, true);
  assert.equal(plainRun.total_rows, 1);
});
