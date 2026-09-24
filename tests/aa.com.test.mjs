import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("../domains/aa.com/search_flights.js", import.meta.url),
  "utf8",
);
const date = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
const input = {
  origin: "CVG",
  destination: "DFW",
  departDate: date,
  tripType: "oneWay",
  passengers: 1,
};

function load(globals = {}) {
  return vm.runInNewContext(`(${source}\n)`, globals);
}

// Stop before form interaction so these tests exercise entry-page selection only.
async function checkEntry({
  url,
  form = true,
  action,
  visible = true,
  disabled = false,
  title = "",
}) {
  let currentUrl = url;
  const navigations = [];
  const events = [];
  const page = {
    get location() {
      return new URL(currentUrl);
    },
    document: {
      title,
      querySelector(selector) {
        if (selector !== "#reservationFlightSearchForm" || !form) return null;
        return {
          action: action ?? "https://www.aa.com/booking/find-flights",
          querySelectorAll() {
            return [{ disabled, getClientRects: () => (visible ? [{}] : []) }];
          },
        };
      },
      querySelectorAll() {
        return [];
      },
    },
  };
  const [tool] = load({
    js: async (fn) => {
      events.push("inspect");
      return vm.runInNewContext(`(${fn.toString()})()`, page);
    },
    gotoUrl: async (next) => {
      events.push("navigate");
      navigations.push(next);
      currentUrl = next;
    },
    waitForElement: async () => {
      events.push("wait");
      return false;
    },
    pageInfo: async () => ({ url: currentUrl }),
  });
  const output = await tool.execute(input);
  return { navigations, events, output };
}

test("source is one self-contained array expression with the domain patterns", () => {
  const tools = load();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].kind, "cdp");
  assert.equal(tools[0].tool.name, "search_flights");
  assert.equal(tools[0].tool.annotations.readOnlyHint, true);
  assert.equal(tools[0].tool.inputSchema.type, "object");
  assert.equal(tools[0].tool.outputSchema.type, "object");
  assert.equal(typeof tools[0].execute, "function");
  assert.deepEqual(Array.from(tools[0].match.url_patterns), [
    "https://aa.com/*",
    "https://*.aa.com/*",
  ]);
});

for (const url of ["https://www.aa.com/", "https://www.aa.com/homePage.do"]) {
  test(`reuse suitable entry page: ${url}`, async () => {
    const result = await checkEntry({ url });
    assert.deepEqual(result.navigations, []);
    assert.equal(result.events[0], "inspect");
    assert.equal(result.output.status, "timeout");
  });
}

for (const options of [
  { url: "https://www.aa.com/booking/choose-flights/1?sid=example" },
  { url: "https://www.aa.com/travelInformation/flights/status" },
  { url: "https://aa.com/" },
  { url: "https://booking.aa.com/" },
  { url: "https://example.com/" },
  { url: "http://www.aa.com/homePage.do" },
  { url: "https://www.aa.com/homePage.do", form: false },
  { url: "https://www.aa.com/homePage.do", visible: false },
  { url: "https://www.aa.com/homePage.do", disabled: true },
  {
    url: "https://www.aa.com/homePage.do",
    action: "https://example.com/search",
  },
]) {
  test(`navigate before using an unsuitable page: ${JSON.stringify(options)}`, async () => {
    const result = await checkEntry(options);
    assert.deepEqual(result.navigations, ["https://www.aa.com/homePage.do"]);
    assert.deepEqual(result.events.slice(0, 3), [
      "inspect",
      "navigate",
      "wait",
    ]);
    assert.equal(result.output.status, "timeout");
    assert.equal(result.output.resultCount, 0);
    assert.equal(result.output.totalResults, null);
    assert.equal(result.output.flights.length, 0);
  });
}

test("an access-denied page remains an explicit blocked result", async () => {
  const result = await checkEntry({
    url: "https://www.aa.com/homePage.do",
    form: false,
    title: "Access Denied",
  });
  assert.equal(result.output.status, "blocked");
  assert.equal(result.output.totalResults, null);
});

test("invalid inputs fail before any page navigation", async () => {
  const navigations = [];
  const [tool] = load({
    gotoUrl: async (url) => navigations.push(url),
    pageInfo: async () => ({ url: "https://www.aa.com/" }),
  });
  const result = await tool.execute({ ...input, destination: input.origin });
  assert.equal(result.status, "error");
  assert.equal(result.resultCount, 0);
  assert.deepEqual(navigations, []);
});
