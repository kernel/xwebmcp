import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../domains/delta.com/search_flights.js", import.meta.url), "utf8");
const day = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
const dateLabel = new Date(day + "T12:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const input = { origin: "CVG", destination: "SFO", depart_date: day, trip_type: "one_way", passengers: 1 };

// Drives the tool through the airport pickers of a fabricated booking form. The airport box
// opens prefilled with the geolocated origin and the caret lands inside it, which is how the
// macOS run produced "CVCVG". The harness stops at the trip-type combobox, which it omits.
function harness(options = {}) {
  const box = { value: "", label: null, selected: false, hidden: 0 };
  const events = { selectAll: 0, typed: [], chosen: [], keys: [], presses: 0, trustedClicks: 0, pageClicks: 0 };
  const nodes = () => [
    { role: "button", name: "Origin, CVG, Cincinnati, OH", backendDOMNodeId: 1 },
    { role: "button", name: "One Way Route Picker Destination", backendDOMNodeId: 2 },
    ...(box.label && !box.hidden ? [{ role: "textbox", name: box.label, backendDOMNodeId: 3 }] : []),
    ...(box.label && box.value.length === 3 ? [{ role: "option", name: `${box.value} ${box.value} airport`, backendDOMNodeId: 4 }] : []),
    ...(options.fullForm ? [
      { role: "combobox", name: "Trip Type, Round Trip" }, { role: "option", name: "One Way" },
      { role: "combobox", name: "Passenger Count, 1" }, { role: "option", name: "1 Passenger" },
      { role: "button", name: "Flight Date Field, DepartDate" },
      { role: "gridcell", name: dateLabel },
      { role: "button", name: options.doneName ?? "Date Picker Done Button" }
    ] : [])
  ];
  let clock = Date.now();
  class FakeDate extends Date { constructor(...a) { super(...(a.length ? a : [clock])); } static now() { return clock; } }
  const context = {
    URL, Math, Date: FakeDate, Error, JSON, Object, Event: class {},
    pageInfo: async () => ({ url: "https://www.delta.com/flightsearch/book-a-flight" }),
    gotoUrl: async () => {},
    waitForElement: async () => true,
    waitMs: async (ms = 1000) => { clock += ms; },
    cdp: async (method, params) => {
      if (params?.commands?.includes("selectAll")) { events.selectAll++; if (!options.clearFails) box.selected = true; }
      return {};
    },
    accessibilitySnapshot: async () => { const snapshot = { nodes: nodes() }; if (box.hidden) box.hidden--; return snapshot; },
    click: async n => {
      if (n === "#findFilghtsCta") { events.presses++; events.trustedClicks++; return; }
      if (n?.role === "button") box.label = n.name.startsWith("Origin") ? "Origin" : "Destination";
      if (n?.role === "button") box.value = box.label === "Origin" ? "CVG" : "";
      if (n?.role === "button" && /^(Origin|One Way)/.test(n.name)) box.hidden = options.boxDelay ?? 0;
      if (n?.role === "option") { events.chosen.push(n.name.slice(0, 3)); box.label = null; }
    },
    pressKey: async key => {
      events.keys.push(key);
      if (key === "Backspace") box.value = box.selected ? "" : box.value.slice(0, -1);
      else if (key.length === 1) box.value = (box.selected ? "" : box.value) + (options.doubled ? key.toUpperCase().repeat(2) : key.toUpperCase());
      box.selected = false;
    },
    js: async (fn) => {
      const body = fn.toString();
      if (body.includes("search-results")) return events.presses >= (options.submitStartsOn ?? 1);
      if (body.includes("getBoundingClientRect().width")) { events.pageClicks++; if (options.noVisibleButton) return false; events.presses++; return true; }
      if (body.includes("route-picker")) return "Origin, CVG | Destination, SFO | Trip Type, One Way";
      if (body.includes("findFilghtsCta")) return true;
      if (body.includes("isContentEditable")) return box.value;
      if (body.includes("select()")) return null;
      if (body.includes("activeElement?.value")) { events.typed.push(box.value); return box.value; }
      return null;
    }
  };
  const [tool] = runInNewContext(`(${source})`, context);
  return { run: () => tool.execute(input), events };
}

test("clears the prefilled airport box before typing and chooses the typed airport", async () => {
  const h = harness();
  const out = await h.run();
  assert.deepEqual(h.events.typed, ["CVG", "SFO"]);
  assert.deepEqual(h.events.chosen, ["CVG", "SFO"]);
  assert.equal(h.events.selectAll, 2);
  assert.equal(h.events.keys.filter(k => k === "Backspace").length, 2);
  assert.equal(out.status, "error");
  assert.match(out.message, /UI_CHANGED: missing combobox/);
});

test("reports INPUT_MISMATCH instead of choosing a wrong airport", async () => {
  const h = harness({ doubled: true });
  const out = await h.run();
  assert.equal(out.status, "error");
  assert.match(out.message, /INPUT_MISMATCH: Origin box holds "CCVVGG" instead of CVG/);
  assert.deepEqual(h.events.chosen, []);
});

test("stops when the airport box cannot be cleared", async () => {
  const h = harness({ clearFails: true });
  const out = await h.run();
  assert.equal(out.status, "error");
  assert.match(out.message, /typeInto: could not clear the field, it still holds 1 character\(s\)/);
  assert.deepEqual(h.events.chosen, []);
});

test("submit: one trusted press that starts the search needs no fallback", async () => {
  const h = harness({ fullForm: true, submitStartsOn: 1 });
  const out = await h.run();
  assert.equal(h.events.trustedClicks, 1);
  assert.equal(h.events.pageClicks, 0);
  assert.doesNotMatch(out.message ?? "", /SUBMIT_FAILED/);
});

test("submit: a press that does nothing is retried once on the visible button", async () => {
  const h = harness({ fullForm: true, submitStartsOn: 2 });
  const out = await h.run();
  assert.equal(h.events.trustedClicks, 1);
  assert.equal(h.events.pageClicks, 1);
  assert.doesNotMatch(out.message ?? "", /SUBMIT_FAILED/);
});

test("submit: two presses without a search report SUBMIT_FAILED with the form state", async () => {
  const h = harness({ fullForm: true, submitStartsOn: 99 });
  const out = await h.run();
  assert.equal(out.status, "error");
  assert.equal(h.events.pageClicks, 1);
  assert.match(out.message, /SUBMIT_FAILED: Find Flights did not start a search after two presses; form shows: Origin, CVG/);
  assert.deepEqual([...out.flights], []);
  assert.equal(out.result_count, null);
});

test("submit: no visible Find Flights button for the retry reports SUBMIT_FAILED", async () => {
  const h = harness({ fullForm: true, submitStartsOn: 99, noVisibleButton: true });
  const out = await h.run();
  assert.match(out.message, /SUBMIT_FAILED/);
});

test("waits for an airport box that renders after the picker opens and accepts the plain Done button", async () => {
  const h = harness({ fullForm: true, boxDelay: 4, doneName: "Done", submitStartsOn: 1 });
  const out = await h.run();
  assert.deepEqual(h.events.chosen, ["CVG", "SFO", "One", "1 P"]);
  assert.equal(h.events.presses, 1);
  assert.doesNotMatch(out.message ?? "", /UI_CHANGED|SUBMIT_FAILED/);
});

test("still reports UI_CHANGED when the airport box never appears", async () => {
  const h = harness({ boxDelay: 1000 });
  const out = await h.run();
  assert.equal(out.status, "error");
  assert.match(out.message, /UI_CHANGED: missing textbox/);
});
