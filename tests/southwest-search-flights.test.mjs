import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(
  new URL("../domains/southwest.com/search_flights.js", import.meta.url),
  "utf8",
);
const entryUrl = "https://www.southwest.com/";
const resultsUrl = "https://www.southwest.com/air/booking/select-depart.html";
const input = {
  origin: "DAL",
  destination: "HOU",
  departureDate: "2099-10-15",
  returnDate: "2099-10-18",
  tripType: "roundtrip",
  passengers: 1,
};
const plain = (value) => JSON.parse(JSON.stringify(value));

function harness({
  url = "https://www.southwest.com/air/low-fare-calendar/",
  hasForm = false,
  entryLoads = true,
  state = { ready: true, count: 1 },
  navigationError = false,
} = {}) {
  const navigations = [];
  const waits = [];
  const flight = { flightNumbers: ["WN1628"] };
  let reads = 0;
  const context = {
    URLSearchParams,
    pageInfo: async () => ({ url }),
    location: new URL(url),
    document: { querySelector: () => (hasForm ? {} : null) },
    gotoUrl: async (next) => {
      navigations.push(next);
      if (navigationError) throw Error("Inspected target navigated or closed");
      url = next;
    },
    waitForElement: async (selector, options) => {
      waits.push({ selector, ...options });
      return entryLoads;
    },
    js: async (fn) => {
      reads += 1;
      if (reads === 1) return fn();
      if (reads === 2) return { url, ...state };
      return [flight];
    },
  };
  const definitions = runInNewContext(`(${source})`, context);
  return { definitions, navigations, waits, flight };
}

test("source is a standalone tool-array expression with domain-only patterns", () => {
  const { definitions } = harness();
  assert.equal(definitions.length, 1);
  const definition = definitions[0];
  assert.equal(definition.kind, "cdp");
  assert.equal(definition.tool.name, "search_flights");
  assert.deepEqual(plain(definition.match.url_patterns), [
    "https://southwest.com/*",
    "https://*.southwest.com/*",
  ]);
  assert.equal(definition.tool.inputSchema.type, "object");
  assert.equal(definition.tool.outputSchema.type, "object");
  assert.equal(definition.tool.annotations.readOnlyHint, true);
});

for (const url of [
  "https://www.southwest.com/air/low-fare-calendar/",
  resultsUrl,
  "https://southwest.com/",
  "https://mobile.southwest.com/",
  "https://example.com/",
]) {
  test(`opens the entry point from ${url}`, async () => {
    const h = harness({ url });
    const result = await h.definitions[0].execute(input);
    assert.equal(h.navigations[0], entryUrl);
    assert.equal(h.waits[0].selector, "#originationAirportCode");
    assert.equal(h.waits[0].timeoutSec, 30);
    const search = new URL(h.navigations[1]);
    assert.equal(search.origin + search.pathname, resultsUrl);
    assert.equal(search.searchParams.get("returnDate"), input.returnDate);
    assert.equal(result.status, "ok");
    assert.equal(result.resultCount, 1);
    assert.deepEqual(plain(result.flights), [h.flight]);
  });
}

test("a ready homepage needs only the search navigation", async () => {
  const h = harness({ url: entryUrl, hasForm: true });
  await h.definitions[0].execute({ ...input, passengers: 3 });
  assert.equal(h.navigations.length, 1);
  assert.equal(h.waits.length, 0);
  assert.equal(new URL(h.navigations[0]).searchParams.get("adultsCount"), "3");
});

test("a homepage without its form is not a suitable entry point", async () => {
  const h = harness({ url: entryUrl });
  await h.definitions[0].execute(input);
  assert.equal(h.navigations[0], entryUrl);
  assert.equal(h.navigations.length, 2);
});

test("entry timeout returns site_error without submitting the search", async () => {
  const h = harness({ entryLoads: false });
  const result = await h.definitions[0].execute(input);
  assert.equal(result.status, "site_error");
  assert.equal(result.resultCount, 0);
  assert.match(result.message, /entry form did not load/);
  assert.deepEqual(h.navigations, [entryUrl]);
});

test("navigation failures remain explicit", async () => {
  const h = harness({ navigationError: true });
  const result = await h.definitions[0].execute(input);
  assert.equal(result.status, "site_error");
  assert.equal(result.resultCount, 0);
});

test("one-way searches omit returnDate", async () => {
  const h = harness();
  const { returnDate, ...oneway } = input;
  await h.definitions[0].execute({ ...oneway, tripType: "oneway" });
  assert.equal(new URL(h.navigations[1]).searchParams.has("returnDate"), false);
});

test("invalid inputs do not navigate", async () => {
  const h = harness();
  const result = await h.definitions[0].execute({
    ...input,
    destination: "DAL",
  });
  assert.equal(result.status, "invalid_input");
  assert.equal(h.navigations.length, 0);
});

test("an explicit empty page remains no_results", async () => {
  const h = harness({
    state: { noResults: true, count: 0, message: "No flights available" },
  });
  const result = await h.definitions[0].execute(input);
  assert.equal(result.status, "no_results");
  assert.equal(result.resultCount, 0);
});
