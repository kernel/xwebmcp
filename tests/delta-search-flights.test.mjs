import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../domains/delta.com/search_flights.js", import.meta.url), "utf8");
const day = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
const input = { origin: "CVG", destination: "SFO", depart_date: day, trip_type: "one_way", passengers: 1 };

// Drives the tool through the airport pickers of a fabricated booking form. The airport box
// opens prefilled with the geolocated origin and the caret lands inside it, which is how the
// macOS run produced "CVCVG". The harness stops at the trip-type combobox, which it omits.
function harness(options = {}) {
  const box = { value: "", label: null, selected: false };
  const events = { selectAll: 0, typed: [], chosen: [], keys: [], snapshots: 0, waits: [], navigations: 0 };
  let pending = 0;
  const nodes = () => [
    { role: "button", name: "Origin, CVG, Cincinnati, OH", backendDOMNodeId: 1 },
    { role: "button", name: "One Way Route Picker Destination", backendDOMNodeId: 2 },
    ...(box.label && !options.missingTextbox && pending-- <= 0 ? [{ role: "textbox", name: box.label, backendDOMNodeId: 3 }] : []),
    ...(box.label && box.value.length === 3 ? [{ role: "option", name: `${box.value} ${box.value} airport`, backendDOMNodeId: 4 }] : [])
  ];
  const context = {
    URL, Math, Date, Error, JSON, Object, Event: class {},
    pageInfo: async () => ({ url: "https://www.delta.com/flightsearch/book-a-flight" }),
    gotoUrl: async () => { events.navigations++; },
    waitForElement: async () => true,
    waitMs: async ms => { events.waits.push(ms); },
    cdp: async (method, params) => {
      if (params?.commands?.includes("selectAll")) { events.selectAll++; if (!options.clearFails) box.selected = true; }
      return {};
    },
    accessibilitySnapshot: async () => { events.snapshots++; return { nodes: nodes() }; },
    click: async n => {
      if (n?.role === "button") pending = options.delayedSnapshots ?? 0;
      if (n?.role === "button") box.label = n.name.startsWith("Origin") ? "Origin" : "Destination";
      if (n?.role === "button") box.value = box.label === "Origin" ? "CVG" : "";
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
      if (body.includes("findFilghtsCta")) return true;
      if (body.includes("isContentEditable")) return box.value;
      if (body.includes("select()")) return null;
      if (body.includes("activeElement?.value")) { events.typed.push(box.value); return box.value; }
      return null;
    }
  };
  const [tool] = runInNewContext(`(${source})`, context);
  return { run: (value = input) => tool.execute(value), events };
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

test("waits for asynchronous airport textboxes before typing", async () => {
  const h = harness({ delayedSnapshots: 3 });
  const out = await h.run();
  assert.deepEqual(h.events.chosen, ["CVG", "SFO"]);
  assert.ok(h.events.waits.filter(ms => ms === 150).length >= 6);
  assert.match(out.message, /UI_CHANGED: missing combobox/);
});

test("a missing airport textbox fails after a bounded wait without typing", async () => {
  const h = harness({ missingTextbox: true });
  const out = await h.run();
  assert.match(out.message, /UI_CHANGED: missing Origin textbox/);
  assert.equal(h.events.waits.filter(ms => ms === 150).length, 20);
  assert.deepEqual(h.events.chosen, []);
  assert.deepEqual(h.events.keys, []);
});

for (const bad of [null, [], {}, { ...input, origin: "AAA", destination: "AAA" }, { ...input, depart_date: "2026-02-30" }, { ...input, confirmed: true }]) {
  test(`invalid search input precedes interaction: ${JSON.stringify(bad)}`, async () => {
    const h = harness();
    const out = await h.run(bad);
    assert.match(out.message, /^INVALID_INPUT:/);
    assert.equal(h.events.snapshots, 0);
    assert.equal(h.events.navigations, 0);
    assert.deepEqual(h.events.keys, []);
  });
}

test("stops when the airport box cannot be cleared", async () => {
  const h = harness({ clearFails: true });
  const out = await h.run();
  assert.equal(out.status, "error");
  assert.match(out.message, /typeInto: could not clear the field, it still holds 1 character\(s\)/);
  assert.deepEqual(h.events.chosen, []);
});
