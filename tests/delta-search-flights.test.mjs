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
  const events = { selectAll: 0, typed: [], chosen: [], keys: [] };
  const nodes = () => [
    { role: "button", name: "Origin, CVG, Cincinnati, OH", backendDOMNodeId: 1 },
    { role: "button", name: "One Way Route Picker Destination", backendDOMNodeId: 2 },
    ...(box.label ? [{ role: "textbox", name: box.label, backendDOMNodeId: 3 }] : []),
    ...(box.label && box.value.length === 3 ? [{ role: "option", name: `${box.value} ${box.value} airport`, backendDOMNodeId: 4 }] : [])
  ];
  const context = {
    URL, Math, Date, Error, JSON, Object, Event: class {},
    pageInfo: async () => ({ url: "https://www.delta.com/flightsearch/book-a-flight" }),
    gotoUrl: async () => {},
    waitForElement: async () => true,
    waitMs: async () => {},
    cdp: async (method, params) => {
      if (params?.commands?.includes("selectAll")) { events.selectAll++; if (!options.clearFails) box.selected = true; }
      return {};
    },
    accessibilitySnapshot: async () => ({ nodes: nodes() }),
    click: async n => {
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
