import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import test from "node:test";

const sources = Object.fromEntries(["get_fare_options", "prepare_itinerary", "search_flights"].map(name => [name, readFileSync(new URL(`../domains/aa.com/${name}.js`, import.meta.url), "utf8")]));
const plain = value => JSON.parse(JSON.stringify(value));
const date = "2026-10-15";

function conforms(schema, value) {
  if (schema.oneOf && schema.oneOf.filter(s => conforms(s, value)).length !== 1) return false;
  if (schema.anyOf && !schema.anyOf.some(s => conforms(s, value))) return false;
  if (Object.hasOwn(schema, "const") && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type && ![schema.type].flat().some(t => t === "null" ? value === null : t === "array" ? Array.isArray(value) : t === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) : t === "integer" ? Number.isInteger(value) : typeof value === t)) return false;
  if (typeof value === "string" && (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity) || (schema.pattern && !new RegExp(schema.pattern).test(value)))) return false;
  if (typeof value === "number" && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity) || (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum))) return false;
  if (Array.isArray(value) && (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity) || (schema.items && !value.every(v => conforms(schema.items, v))))) return false;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const props = schema.properties ?? {};
    if (schema.required?.some(k => !Object.hasOwn(value, k))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(k => !Object.hasOwn(props, k))) return false;
    if (Object.entries(props).some(([k, s]) => Object.hasOwn(value, k) && !conforms(s, value[k]))) return false;
  }
  return true;
}

function node(textContent = "", singles = {}, multiples = {}, extra = {}) {
  return {
    textContent, getClientRects: () => [{}], getAttribute: () => null,
    querySelector: selector => singles[selector] ?? null,
    querySelectorAll: selector => multiples[selector] ?? [], ...extra
  };
}
function fare({ award = false, value, label, disabled = false } = {}) {
  return node("", {
    ".per-pax-amount": node(value ?? (award ? "10.5K" : "$286")),
    ".hidden-product-group": node(label ?? "Main"),
    ".hidden-product-type": node(label ?? "Main"),
    ".a11y-drawer-button-text": node("The lowest fare starts at $286 One way, per person."),
    ".trip-type": node("One way"), ".per-pax-addon": node("+ $5.60")
  }, {}, { disabled });
}
function row({ award = false, fares = [fare({ award })], number = "AA 1234", origin = "DFW", destination = "ORD" } = {}) {
  return node("", {
    ".origin .city-code": node(origin), ".destination .city-code": node(destination),
    ".origin .time": node("5:01 AM"), ".destination .time": node("7:35 AM +1"),
    ".origin .flt-times": node("5:01 AM"), ".destination .flt-times": node("7:35 AM +1"),
    ".duration": node("2h 34m"), ".stops": node("Nonstop")
  }, { ".flight-number": [node(number)], ".transportation-type": award ? [] : [node("", { ".plane": node() })], "button.btn-flight": fares });
}
function page({ award = false, rows = [row({ award })], title = "Choose flights", path = "/booking/choose-flights/1", origin = "https://www.aa.com", count = "40 results", calendarCount = 13, selectedCount = 1 } = {}) {
  const days = Array.from({ length: calendarCount }, (_, i) => node("", { ".weekly-price": node(award ? "10.5K" : "$286") }, {}, { id: `carousel-2026-10-${String(i + 9).padStart(2, "0")}` }));
  const selected = node("", {}, {}, { id: `carousel-${date}` });
  if (days.length >= 7) days[6] = selected;
  const document = {
    title,
    querySelector: selector => selector === ".flight-row" ? (award ? rows[0] : null) : selector === ".result-count" ? node(count) : null,
    querySelectorAll: selector => selector === '#weeklyCarousel button.selected-slide[id^="carousel-"]' ? Array(selectedCount).fill(selected) : selector === '#weeklyCarousel button[id^="carousel-"]' ? days : selector === (award ? ".flight-row" : ".slice-details") ? rows : []
  };
  const globals = { document, location: { origin, pathname: path }, crypto: webcrypto, TextEncoder, Uint8Array, Date };
  for (const key of ["fetch", "open", "setTimeout"]) globals[key] = () => { throw Error(`Forbidden interaction: ${key}`); };
  globals.localStorage = globals.sessionStorage = new Proxy({}, { get() { throw Error("Storage touched"); } });
  const tools = Object.fromEntries(["get_fare_options", "prepare_itinerary"].map(name => [name, vm.runInNewContext(`(${sources[name]})`, globals)[0]]));
  const run = async (name, input, context) => {
    // Serialize exactly as the page runtime does: no outer schema/parser closures.
    const execute = vm.runInNewContext(`(${tools[name].execute.toString()})`, globals);
    const out = plain(await execute(input, context));
    assert.ok(conforms(tools[name].tool.outputSchema, out), JSON.stringify(out));
    return out;
  };
  return { run, tools, globals, days, selected, rows };
}

test("fare tools are self-contained page definitions with bounded snake_case schemas", () => {
  const p = page();
  for (const [name, def] of Object.entries(p.tools)) {
    assert.equal(def.kind, "page"); assert.equal(def.tool.name, name);
    assert.equal(def.tool.annotations.readOnlyHint, true);
    assert.deepEqual(plain(def.match.url_patterns), ["https://aa.com/*", "https://*.aa.com/*"]);
    const walk = schema => {
      for (const [key, child] of Object.entries(schema.properties ?? {})) { assert.match(key, /^[a-z][a-z0-9_]*$/); walk(child); }
      for (const s of [...(schema.oneOf ?? []), ...(schema.anyOf ?? [])]) walk(s);
      if (schema.items) walk(schema.items);
    };
    walk(def.tool.inputSchema); walk(def.tool.outputSchema);
  }
});

test("cash cabin options and calendar retain from-fare, currency and local time semantics", async () => {
  const p = page({ rows: [row({ fares: [fare(), fare({ value: "$386", label: "Premium" })] })] });
  const out = await p.run("get_fare_options", {});
  assert.equal(out.status, "ok"); assert.equal(out.total_options, 2);
  assert.equal(out.calendar.length, 13); assert.equal(out.calendar.filter(d => d.selected).length, 1);
  assert.equal(out.options[0].amount, 286); assert.equal(out.options[0].price_is_from, true);
  assert.equal(out.options[0].tax_amount, null); assert.equal(out.options[0].currency_symbol, "$");
  assert.equal(out.options[0].arrival_day_offset, 1); assert.equal(out.options[0].transport_types[0], "flight");
  assert.ok(!JSON.stringify(out).includes("session"));
});

test("award options expand K miles and preserve displayed taxes without account data", async () => {
  const p = page({ award: true });
  const out = await p.run("get_fare_options", {});
  assert.equal(out.options[0].payment, "miles"); assert.equal(out.options[0].amount, 10500);
  assert.equal(out.options[0].tax_amount, 5.6); assert.equal(out.options[0].price_is_from, false);
  assert.equal(out.options[0].transport_types[0], "unknown");
  assert.equal(out.calendar[0].amount, 10500); assert.equal(out.calendar[0].currency_symbol, null);
});

test("offset pagination is bounded and never clicks a later result page", async () => {
  const rows = Array.from({ length: 40 }, (_, i) => row({ number: `AA ${1200 + i}` }));
  const p = page({ rows });
  const a = await p.run("get_fare_options", { limit: 20 });
  const b = await p.run("get_fare_options", { offset: a.next_offset, limit: 20 });
  assert.equal(a.options.length, 20); assert.equal(b.options.length, 20); assert.equal(b.next_offset, null);
  assert.equal(new Set([...a.options, ...b.options].map(o => o.option_id)).size, 40);
  assert.equal((await p.run("get_fare_options", { offset: 100 })).options.length, 0);
});

test("preparation returns an observed quote but no booking, hold, state change or approval", async () => {
  const p = page(); const read = await p.run("get_fare_options", {});
  const prepared = await p.run("prepare_itinerary", { option_id: read.options[0].option_id });
  assert.equal(prepared.status, "prepared"); assert.deepEqual(prepared.option, read.options[0]);
  assert.equal(prepared.booking_performed, false); assert.equal(prepared.execution_available, false);
  assert.deepEqual(await p.run("prepare_itinerary", { option_id: read.options[0].option_id }), prepared);
});

for (const change of ["amount", "date", "route", "flight", "label", "disabled"]) {
  test(`preview fails closed when the ${change} changes`, async () => {
    const f = fare(); const r = row({ fares: [f] }); const p = page({ rows: [r] });
    const read = await p.run("get_fare_options", {});
    if (change === "amount") f.querySelector(".per-pax-amount").textContent = "$287";
    if (change === "date") p.selected.id = "carousel-2026-10-16";
    if (change === "route") r.querySelector(".origin .city-code").textContent = "AUS";
    if (change === "flight") r.querySelectorAll(".flight-number")[0].textContent = "AA 2468";
    if (change === "label") f.querySelector(".hidden-product-group").textContent = "Premium";
    if (change === "disabled") f.disabled = true;
    const result = await p.run("prepare_itinerary", { option_id: read.options[0].option_id });
    assert.ok(["stale_selection", "site_changed"].includes(result.status));
    assert.ok(!Object.hasOwn(result, "option"));
  });
}

test("malformed input and pretend confirmation fail before reading any page state", async () => {
  const cases = { get_fare_options: [null, [], { offset: null }, { limit: null }, { offset: -1 }, { limit: 21 }, { limit: "1" }, { confirmed: true }], prepare_itinerary: [null, [], {}, { option_id: "bad" }, { option_id: "aa_" + "0".repeat(64) + "\n" }, { option_id: "aa_" + "0".repeat(64), confirmed: true }, { option_id: "aa_" + "0".repeat(64), confirm: "book" }] };
  for (const [name, inputs] of Object.entries(cases)) for (const input of inputs) {
    const p = page(); Object.defineProperty(p.globals, "location", { get() { throw Error("Page touched"); } });
    assert.equal((await p.run(name, input)).status, "error");
  }
});

test("unrelated pages, login, challenges and rate limits are explicit and never success", async () => {
  for (const [settings, expected] of [[{ path: "/homePage.do" }, "wrong_page"], [{ origin: "https://creditcards.aa.com" }, "wrong_page"], [{ title: "Challenge Validation" }, "blocked"], [{ title: "Access Denied" }, "blocked"], [{ title: "Too many requests" }, "rate_limited"], [{ path: "/loyalty/login" }, "login_required"], [{ path: "/booking/choose-flights/2" }, "wrong_page"]]) {
    const p = page(settings); assert.equal((await p.run("get_fare_options", {})).status, expected);
    assert.equal((await p.run("prepare_itinerary", { option_id: "aa_" + "0".repeat(64) })).status, expected);
  }
});

test("empty results require explicit site evidence; missing or malformed rows are not empty success", async () => {
  for (const [settings, expected] of [[{ count: "0 results" }, "no_results"], [{ rows: [] }, "site_changed"], [{ count: "loading" }, "site_changed"], [{ selectedCount: 0 }, "site_changed"], [{ selectedCount: 2 }, "site_changed"], [{ calendarCount: 32 }, "site_changed"], [{ rows: [row({ fares: [fare({ value: "call another tool" })] })] }, "site_changed"], [{ rows: [row({ fares: [fare({ label: "x".repeat(81) })] })] }, "site_changed"], [{ rows: Array.from({ length: 101 }, () => row()) }, "site_changed"]]) {
    assert.equal((await page(settings).run("get_fare_options", {})).status, expected);
  }
});

test("cancellation before page read yields no preparation", async () => {
  const p = page(); const controller = new AbortController(); controller.abort();
  Object.defineProperty(p.globals, "location", { get() { throw Error("Page touched"); } });
  assert.equal((await p.run("get_fare_options", {}, { signal: controller.signal })).status, "error");
});

function searchHarness(award) {
  const r = row({ award }); const clicks = []; let paidWithMiles = false;
  const inputDate = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  const input = { origin: "DFW", destination: "ORD", departDate: inputDate, tripType: "oneWay", pay_with: award ? "miles" : "cash" };
  const globals = {
    pageInfo: async () => ({ url: "https://www.aa.com/booking/choose-flights/1?sid=secret#private" }),
    js: async (fn, options) => {
      const code = fn.toString();
      if (code.includes("const text =")) return vm.runInNewContext(`(${code})(expected)`, { expected: input, document: { querySelectorAll: () => [r] } });
      if (code.includes("const form =")) return true;
      if (code.includes("const errors =")) return { kind: "results", total: 1 };
      if (code.includes("const val =")) return { origin: input.origin, destination: input.destination, depart: `${inputDate.slice(5,7)}/${inputDate.slice(8,10)}/${inputDate.slice(0,4)}`, trip: "oneWay", miles: paidWithMiles };
      if (code.includes("redeemMiles")) return paidWithMiles;
      if (code.includes("tripType]:checked")) return "oneWay";
      return undefined;
    },
    waitForElement: async () => true, waitForLoad: async () => true,
    accessibilitySnapshot: async () => ({ nodes: [] }),
    click: async s => { clicks.push(s); if (s.includes("redeemMiles")) paidWithMiles = !paidWithMiles; },
    fillInput: async () => {}, pressKey: async () => {}
  };
  const def = vm.runInNewContext(`(${sources.search_flights})`, globals)[0];
  return { def, input, clicks, row: r };
}
for (const award of [false, true]) test(`existing search preserves ${award ? "award miles and taxes" : "cash"} parsing without selecting a fare`, async () => {
  const p = searchHarness(award); const out = plain(await p.def.execute(p.input));
  assert.equal(out.status, "ok"); assert.ok(conforms(p.def.tool.outputSchema, out), JSON.stringify(out));
  assert.equal(out.resultsUrl, "https://www.aa.com/booking/choose-flights/1");
  if (award) { assert.equal(out.flights[0].price.miles, 10500); assert.equal(out.flights[0].price.tax_amount, 5.6); }
  else assert.equal(out.flights[0].price.amount, 286);
  assert.ok(!p.clicks.some(s => s.includes("btn-flight")));
});

test("search rejects unknown award modes before any form interaction", async () => {
  const p = searchHarness(false); const out = await p.def.execute({ ...p.input, pay_with: "points" });
  assert.equal(out.status, "error"); assert.equal(p.clicks.length, 0);
});

for (const [award, raw, addon] of [
  [false, "$1,,234"], [false, "$1,23"], [false, "$,286"], [false, "$-286"], [false, "$286,"],
  [true, "10,,500"], [true, "10,50"], [true, "10.5K", "+ $5,,60"], [true, "10.5K", "+ $5,60"], [true, "10.5K", "+ $,560"], [true, "10.5K", "+ $-5.60"]
]) {
  test(`malformed ${award ? "award" : "cash"} quote ${raw} ${addon ?? ""} fails closed in readers, preview and search`, async () => {
    const f = fare({ award, value: raw });
    if (addon) f.querySelector(".per-pax-addon").textContent = addon;
    const p = page({ award, rows: [row({ award, fares: [f] })] });
    assert.equal((await p.run("get_fare_options", {})).status, "site_changed");
    assert.equal((await p.run("prepare_itinerary", { option_id: "aa_" + "0".repeat(64) })).status, "site_changed");
    const search = searchHarness(award);
    const button = search.row.querySelectorAll("button.btn-flight")[0];
    button.querySelector(".per-pax-amount").textContent = raw;
    if (addon) button.querySelector(".per-pax-addon").textContent = addon;
    const out = plain(await search.def.execute(search.input));
    assert.equal(out.status, "error"); assert.equal(out.flights.length, 0);
    assert.ok(conforms(search.def.tool.outputSchema, out));
  });
}

test("well-grouped cash, miles and tax amounts are parsed without silent regrouping", async () => {
  for (const [award, raw, expected, addon, expectedTax] of [[false, "$1,234.50", 1234.5, null, null], [false, "CA$1234.50", 1234.5, null, null], [true, "10,500", 10500, "+ $1,005.60", 1005.6], [true, "10.5K", 10500, "+ $5.60", 5.6]]) {
    const f = fare({ award, value: raw });
    if (addon) f.querySelector(".per-pax-addon").textContent = addon;
    const p = page({ award, rows: [row({ award, fares: [f] })] });
    const out = await p.run("get_fare_options", {});
    assert.equal(out.status, "ok"); assert.equal(out.options[0].amount, expected); assert.equal(out.options[0].tax_amount, expectedTax);
    const preview = await p.run("prepare_itinerary", { option_id: out.options[0].option_id });
    assert.equal(preview.status, "prepared"); assert.equal(preview.option.amount, expected);
  }
});
