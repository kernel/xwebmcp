import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../domains/united.com/search_flights.js", import.meta.url), "utf8");
const departDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
const input = { origin: "SFO", destination: "LAX", departDate, tripType: "one_way", passengers: 1 };
const target = "https://www.united.com/en/us/fsr/choose-flights?" + new URLSearchParams({
  f: "SFO", t: "LAX", d: departDate, sc: "7", px: "1,0,0,0,0,0,0,0",
  taxng: "1", newHP: "True", clm: "7", st: "bestmatches", tqp: "R", tt: "1"
});

function harness(url) {
  const navigation = [];
  let pageReads = 0;
  const tools = runInNewContext(`(${source})`, {
    URLSearchParams,
    pageInfo: async () => { pageReads++; return { url }; },
    gotoUrl: async next => { navigation.push(next); url = next; },
    waitForElement: async () => false
  });
  return { tools, navigation, pageReads: () => pageReads };
}

test("source is a self-contained tool-array expression with both schemas", () => {
  const { tools } = harness("about:blank");
  assert.equal(tools.length, 1);
  assert.equal(tools[0].kind, "cdp");
  assert.equal(tools[0].tool.name, "search_flights");
  assert.equal(tools[0].tool.annotations.readOnlyHint, true);
  assert.deepEqual(Array.from(tools[0].match.url_patterns), ["https://united.com/*", "https://*.united.com/*"]);
  assert.equal(tools[0].tool.inputSchema.type, "object");
  assert.equal(tools[0].tool.outputSchema.type, "object");
  assert.equal(typeof tools[0].execute, "function");
});

for (const url of [
  "https://www.united.com/en/us/fly/travel.html",
  "https://www.united.com/en/us/fsr/choose-flights?f=SFO&t=NRT",
  "https://united.com/",
  "https://help.united.com/",
  "https://example.com/"
]) {
  test(`enters the requested search from ${url}`, async () => {
    const h = harness(url);
    const result = await h.tools[0].execute(input);
    assert.equal(h.pageReads(), 1);
    assert.deepEqual(h.navigation, [target]);
    assert.equal(result.status, "error");
    assert.equal(result.error, "TIMEOUT: no results document");
    assert.equal(result.resultsUrl, target);
    assert.equal(result.resultCount, 0);
    assert.equal(result.flights.length, 0);
    assert.deepEqual(Object.keys(result).sort(), Array.from(h.tools[0].tool.outputSchema.required).sort());
  });
}

test("an exact search entry still checks readiness without redundant navigation", async () => {
  const h = harness(target);
  const result = await h.tools[0].execute(input);
  assert.equal(h.pageReads(), 1);
  assert.deepEqual(h.navigation, []);
  assert.equal(result.status, "error");
  assert.equal(result.error, "TIMEOUT: no results document");
});

test("invalid input fails before reading or navigating the page", async () => {
  const h = harness("https://example.com/");
  const result = await h.tools[0].execute({ ...input, destination: "SFO" });
  assert.equal(h.pageReads(), 0);
  assert.deepEqual(h.navigation, []);
  assert.equal(result.status, "error");
  assert.match(result.error, /^INVALID_INPUT:/);
  assert.equal(result.resultsUrl, "");
});

test("registry matches the file and domain namespace", () => {
  const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
  const entries = registry.tools.filter(entry => entry.domain === "united.com" && entry.tool === "search_flights");
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.namespace, "united.com");
  assert.equal(entry.file, "domains/united.com/search_flights.js");
  assert.equal(entry.kind, "cdp");
  assert.deepEqual(entry.url_patterns, Array.from(harness("about:blank").tools[0].match.url_patterns));
});
