import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../domains/flyfrontier.com/search_flights.js", import.meta.url), "utf8");
const input = {
  origin: "DEN", destination: "LAS", departDate: "2099-10-15",
  tripType: "one_way", passengers: 1
};

function harness(url, { form = true, entryError, entryReady = true } = {}) {
  const navigations = [];
  const waits = [];
  let parsed = false;
  const tools = vm.runInNewContext(`(${source}\n)`, {
    URL, URLSearchParams,
    pageInfo: async () => ({ url }),
    gotoUrl: async next => {
      navigations.push(next);
      url = next;
      return next === "https://www.flyfrontier.com/" && entryError
        ? { errorText: entryError }
        : {};
    },
    waitForElement: async (selector, options) => {
      waits.push({ selector, options });
      return selector !== "#origin" || entryReady;
    },
    js: async (fn, options) => {
      if (options?.arg) {
        parsed = true;
        return { flights: [], empty: ["outbound"], url };
      }
      if (fn.toString().includes("errors.alert-error")) return "";
      return form;
    }
  });
  return { tools, navigations, waits, parsed: () => parsed };
}

test("source is a standalone definition array with domain-scoped matching and typed schemas", () => {
  const { tools } = harness("about:blank");
  assert.equal(tools.length, 1);
  const [definition] = tools;
  assert.equal(definition.kind, "cdp");
  assert.deepEqual(Array.from(definition.match.url_patterns), [
    "https://flyfrontier.com/*", "https://*.flyfrontier.com/*"
  ]);
  assert.equal(definition.tool.name, "search_flights");
  assert.equal(definition.tool.inputSchema.type, "object");
  assert.equal(definition.tool.outputSchema.type, "object");
  assert.equal(definition.tool.annotations.readOnlyHint, true);
});

for (const url of [
  "https://www.flyfrontier.com/optional-services",
  "https://flyfrontier.com/",
  "https://booking.flyfrontier.com/Member/Login",
  "https://example.com/",
  "about:blank"
]) {
  test(`establishes a search entry point from ${url}`, async () => {
    const h = harness(url);
    const result = await h.tools[0].execute(input);
    assert.equal(result.status, "no_results");
    assert.equal(h.navigations[0], "https://www.flyfrontier.com/");
    assert.equal(new URL(h.navigations[1]).pathname, "/Flight/InternalSelect");
    assert.equal(h.waits[0].selector, "#origin");
    assert.equal(h.parsed(), true);
  });
}

for (const url of ["https://www.flyfrontier.com/", "https://booking.flyfrontier.com/Flight/Select"]) {
  test(`reuses a suitable loaded form at ${url}`, async () => {
    const h = harness(url);
    await h.tools[0].execute(input);
    assert.equal(h.navigations.length, 1);
    assert.equal(new URL(h.navigations[0]).pathname, "/Flight/InternalSelect");
  });

  test(`establishes entry when the expected form is missing at ${url}`, async () => {
    const h = harness(url, { form: false });
    await h.tools[0].execute(input);
    assert.equal(h.navigations[0], "https://www.flyfrontier.com/");
    assert.equal(h.navigations.length, 2);
  });
}

test("entry navigation failure remains explicit and never reaches extraction", async () => {
  const h = harness("about:blank", { entryError: "net::ERR_CONNECTION_CLOSED" });
  const result = await h.tools[0].execute(input);
  assert.equal(result.status, "error");
  assert.match(result.error, /^NAVIGATION_FAILED:/);
  assert.equal(h.navigations.length, 1);
  assert.equal(h.parsed(), false);
});

test("entry readiness timeout is an error, not an empty search", async () => {
  const h = harness("about:blank", { entryReady: false });
  const result = await h.tools[0].execute(input);
  assert.equal(result.status, "error");
  assert.match(result.error, /^NAVIGATION_TIMEOUT:/);
  assert.equal(h.navigations.length, 1);
  assert.equal(h.parsed(), false);
});

test("registry agrees with the canonical tool definition", () => {
  const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
  const entry = registry.tools.find(t => t.domain === "flyfrontier.com" && t.tool === "search_flights");
  const [definition] = harness("about:blank").tools;
  assert.ok(entry);
  assert.equal(entry.namespace, entry.domain);
  assert.equal(entry.file, "domains/flyfrontier.com/search_flights.js");
  assert.equal(entry.kind, definition.kind);
  assert.deepEqual(entry.url_patterns, Array.from(definition.match.url_patterns));
});

test("invalid inputs still fail before any navigation", async () => {
  const h = harness("about:blank");
  const result = await h.tools[0].execute({ ...input, passengers: 0 });
  assert.equal(result.status, "error");
  assert.match(result.error, /^INVALID_INPUT:/);
  assert.equal(h.navigations.length, 0);
});
