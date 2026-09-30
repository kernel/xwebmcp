import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { runInNewContext } from "node:vm";

const names = ["get_fare_options", "get_fare_calendar", "prepare_itinerary"];
const sources = Object.fromEntries(names.map(name => [name, readFileSync(new URL(`../domains/united.com/${name}.js`, import.meta.url), "utf8")]));
const input = { origin: "SFO", destination: "LAX", depart_date: "2027-01-10", trip_type: "one_way", passengers: 2 };
const choice = { ...input, offer_id: "row-1", primary_flight: "UA 1234", departure_time: "07:00", arrival_time: "08:40", cabin: "Economy Plus (Extra legroom)", expected_amount: 150 };
const element = (text, more = {}) => ({ innerText: text, textContent: text, getClientRects: () => [{}], checkVisibility: () => more.css_visible !== false, ...more });
const terms = "Fares are for the entire one-way trip, per person. Additional bag charges may apply.";
const headerSelector = '[role="columnheader"][class*="ColumnSortResultHeader-styles__column--"]';
const rowSelector = '[class*="Flight-styles__flightContainer--"]';
const fareSelector = '[role="gridcell"][aria-describedby]';
function row(over = {}) {
  const text = "NONSTOP\nDeparting at 7:00 AM\nArriving at 8:40 AM\nOrigin Example (SFO)\nDestination Example (LAX)\nDuration 1 hours and 40 minutes\nFlight Number UA 1234. Aircraft Example";
  return element(over.text ?? text, {
    querySelectorAll: selector => selector === fareSelector ? (over.cells ?? [element("From $50 United Economy cabin select to view fare options"), element("From $150 United Economy cabin select to view fare options")]) : [],
    querySelector: () => element(over.arrival_label ?? "8:40 AM"),
    ...over
  });
}
const cell = (label = "Depart: Sunday, Jan 10, 2027  from $50", text = "10 from $50 Lowest") => element(text, { getAttribute: () => label });
function harness(name, opts = {}) {
  const reads = [];
  const cells = opts.cells ?? [cell(), cell("Depart: Monday, Jan 11, 2027  from $75", "11 from $75")];
  const dialog = element("Flexible dates", { querySelectorAll: () => cells, querySelector: () => element(opts.calendar_terms ?? "Price display is per person, has been available within the last 24 hours, and may not currently be available. Fares include taxes and fees.") });
  const href = opts.href ?? "https://www.united.com/en/us/fsr/choose-flights?f=SFO&t=LAX&d=2027-01-10&px=2,0,0,0,0,0,0,0&tqp=R&clm=7&tt=1";
  const url = new URL(href);
  const document = {
    title: opts.title ?? "United flights",
    querySelectorAll(selector) {
      reads.push(selector);
      if (selector === 'button[aria-label^="Currently in"]') return opts.locale_missing ? [] : [element("English United States $", { getAttribute: () => opts.locale ?? "Currently in English United States\t$ enter to change" })];
      if (selector === rowSelector) return opts.rows ?? [row()];
      if (selector === headerSelector) return opts.headers ?? [element("United Economy (Main cabin)"), element("Economy Plus (Extra legroom)")];
      if (selector === '[role="dialog"]') return opts.dialogs ?? [dialog];
      if (selector.includes('[role="alert"]')) return opts.alerts ?? [];
      throw new Error("Unexpected selector: " + selector);
    },
    querySelector(selector) {
      reads.push(selector);
      if (selector.includes("travelType")) return opts.payment_missing ? null : { value: opts.payment ?? "money" };
      if (selector.includes("FareDisclaimer")) return element(opts.terms ?? terms);
      if (selector.includes("NoFlights")) return opts.no_flights ?? null;
      throw new Error("Unexpected selector: " + selector);
    }
  };
  const def = runInNewContext(sources[name], { document, location: { origin: url.origin, pathname: url.pathname, href }, URL, Date })[0];
  return { def, reads, run: async (args = input, signal) => JSON.parse(JSON.stringify(await def.execute(args, { signal }))) };
}
function conforms(s, v) {
  if (typeof s === "boolean") return s;
  if (s.oneOf && s.oneOf.filter(x => conforms(x, v)).length !== 1) return false;
  if (s.const !== undefined && s.const !== v) return false;
  if (s.enum && !s.enum.includes(v)) return false;
  if (s.type && ![s.type].flat().some(t => t === "null" ? v === null : t === "array" ? Array.isArray(v) : t === "object" ? v !== null && typeof v === "object" && !Array.isArray(v) : t === "integer" ? Number.isInteger(v) : typeof v === t)) return false;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    if (s.required?.some(k => !Object.hasOwn(v, k))) return false;
    if (s.additionalProperties === false && Object.keys(v).some(k => !Object.hasOwn(s.properties, k))) return false;
    if (Object.entries(s.properties ?? {}).some(([k, x]) => Object.hasOwn(v, k) && !conforms(x, v[k]))) return false;
  }
  if (Array.isArray(v) && (v.length < (s.minItems ?? 0) || v.length > (s.maxItems ?? Infinity) || v.some(x => !conforms(s.items, x)))) return false;
  if (typeof v === "string" && (v.length > (s.maxLength ?? Infinity) || (s.pattern && !new RegExp(s.pattern).test(v)))) return false;
  if (typeof v === "number" && (v < (s.minimum ?? -Infinity) || v > (s.maximum ?? Infinity) || v <= (s.exclusiveMinimum ?? -Infinity))) return false;
  return true;
}
for (const name of names) {
  test(`${name}: trip-type schema requires roundtrip return dates and forbids one-way return dates`, () => {
    const schema = harness(name).def.tool.inputSchema;
    const base = name === "prepare_itinerary" ? choice : input;
    assert.ok(conforms(schema, base));
    assert.ok(conforms(schema, { ...base, trip_type: "roundtrip", return_date: "2027-01-15" }));
    assert.equal(conforms(schema, { ...base, trip_type: "roundtrip" }), false);
    assert.equal(conforms(schema, { ...base, return_date: "2027-01-15" }), false);
  });
  test(`${name}: page kind, no site interaction or execution primitives`, () => {
    const { def } = harness(name);
    assert.equal(def.kind, "page");
    assert.equal(def.tool.annotations.readOnlyHint, true);
    assert.doesNotMatch(def.execute.toString(), /fetch\(|\.click\(|gotoUrl|location\.(?:assign|replace)|localStorage|sessionStorage|document\.cookie|requestSubmit|\.submit\(/);
  });
  test(`${name}: malformed inputs rejected before DOM access`, async () => {
    const base = name === "prepare_itinerary" ? choice : input;
    const invalid = [null, [], "x", {}, { ...base, origin: "sfo" }, { ...base, origin: 123 }, { ...base, destination: "SFO" }, { ...base, passengers: 0 }, { ...base, passengers: 1.2 }, { ...base, passengers: "2" }, { ...base, depart_date: "2027-02-30" }, { ...base, depart_date: {} }, { ...base, trip_type: "unknown" }, { ...base, return_date: "2027-01-15" }, { ...base, confirmed: true }, { ...base, account_id: "fabricated" }, { ...base, trip_type: "roundtrip" }];
    for (const args of invalid) {
      const h = harness(name);
      const out = await h.run(args);
      assert.equal(out.status, "invalid_input", JSON.stringify(args));
      assert.equal(h.reads.length, 0);
      assert.ok(conforms(h.def.tool.outputSchema, out));
    }
  });
  test(`${name}: wrong origins/pages and mismatched query fail closed`, async () => {
    for (const href of ["https://careers.united.com/en/us/fsr/choose-flights", "https://www.united.com/en/us", "https://www.united.com/en/us/fsr/choose-flights?f=SFO&t=LAX&d=2027-01-10&px=2&tqp=R&clm=7&tt=1", "https://www.united.com/en/us/fsr/choose-flights?f=SFO&t=LAX&d=2027-01-11&px=2,0,0,0,0,0,0,0&tqp=R&clm=7&tt=1"]) {
      const h = harness(name, { href });
      assert.equal((await h.run(name === "prepare_itinerary" ? choice : input)).status, "wrong_page");
    }
  });
  test(`${name}: explicit blocking/login/rate outcomes, cancellation and unsupported award modes`, async () => {
    const args = name === "prepare_itinerary" ? choice : input;
    for (const [text, status] of [["Access denied", "blocked"], ["Too many requests", "rate_limited"], ["Sign in to continue", "login_required"]]) {
      assert.equal((await harness(name, { alerts: [element(text)] }).run(args)).status, status);
    }
    for (const payment of ["miles", "moneymiles"]) assert.equal((await harness(name, { payment }).run(args)).status, "wrong_page");
    for (const opts of [{ locale_missing: true }, { locale: "Currently in English Canada $ enter to change" }]) assert.equal((await harness(name, opts).run(args)).status, "wrong_page");
    const h = harness(name);
    assert.equal((await h.run(args, { aborted: true })).status, "cancelled");
    assert.equal(h.reads.length, 0);
  });
}
test("fare options map misleading labels by column, with typed bounded pagination", async () => {
  const h = harness("get_fare_options", { rows: Array.from({ length: 25 }, () => row()) });
  const out = await h.run({ ...input, offset: 5, limit: 20 });
  assert.equal(out.status, "ok");
  assert.equal(out.offers.length, 20);
  assert.equal(out.offers[0].offer_id, "row-6");
  assert.equal(out.offers[0].fares[1].cabin, "Economy Plus (Extra legroom)");
  assert.equal(out.offers[0].fares[1].amount, 150);
  assert.equal(out.next_offset, null);
  assert.equal(out.terms_complete, false);
  assert.ok(conforms(h.def.tool.outputSchema, out));
  assert.equal((await h.run({ ...input, offset: 30 })).status, "no_results");
});
test("fare options: no partial success on drift, bad currencies, missing scope or oversized pages", async () => {
  for (const opts of [{ rows: [] }, { rows: Array.from({ length: 201 }, () => row()) }, { headers: [] }, { headers: [element("Economy"), element("Economy")] }, { terms: "one-way fares" }, { terms: "roundtrip per person" }, { rows: [row({ text: "unreadable" })] }, { rows: [row({ text: row().innerText.replace("Flight Number UA 1234. Aircraft Example", "") })] }, { rows: [row({ cells: [element("From €50 Economy"), element("From $150 Economy")] })] }, { rows: [row({ cells: [element("From $0 Economy"), element("From $150 Economy")] })] }, { rows: [row({ cells: [element("From $1,,2 Economy"), element("From $150 Economy")] })] }, { rows: [row({ cells: [element("From $50 Economy")] })] }]) assert.equal((await harness("get_fare_options", opts).run()).status, "site_changed");
});
test("collapsed connecting rows expose no invented primary flight and cannot be prepared", async () => {
  const text = row().innerText.replace("NONSTOP", "1 STOP").replace("Flight Number UA 1234. Aircraft Example", "");
  const opts = { rows: [row(), row({ text })] };
  const h = harness("get_fare_options", opts);
  const out = await h.run();
  assert.equal(out.status, "ok");
  assert.equal(out.offers[1].primary_flight, null);
  assert.equal(out.offers[1].stops, 1);
  assert.ok(conforms(h.def.tool.outputSchema, out));
  assert.equal((await harness("prepare_itinerary", opts).run({ ...choice, offer_id: "row-2" })).status, "stale_choice");
});
test("unavailable cabin cells do not shift later fares or prevent exact available handoff", async () => {
  const opts = { headers: [element("United Economy"), element("Economy Plus"), element("United First")], rows: [row({ cells: [element("From $50 United Economy"), element("Not available"), element("From $250 United First")] })] };
  const h = harness("get_fare_options", opts);
  const out = await h.run();
  assert.equal(out.status, "ok");
  assert.deepEqual(out.offers[0].fares.map(f => [f.cabin, f.amount]), [["United Economy", 50], ["United First", 250]]);
  assert.ok(conforms(h.def.tool.outputSchema, out));
  const p = harness("prepare_itinerary", opts);
  const prepared = await p.run({ ...choice, cabin: "United First", expected_amount: 250 });
  assert.equal(prepared.status, "ok");
  assert.ok(conforms(p.def.tool.outputSchema, prepared));
  assert.equal((await p.run({ ...choice, cabin: "Economy Plus" })).status, "stale_choice");
});
test("explicit no-flights component precedes missing fare terms, unlike loading or hidden notices", async () => {
  const opts = { rows: [], terms: "", no_flights: element("We couldn't find an exact match") };
  const h = harness("get_fare_options", opts);
  const out = await h.run();
  assert.equal(out.status, "no_results");
  assert.ok(conforms(h.def.tool.outputSchema, out));
  assert.equal((await harness("get_fare_options", { rows: [], terms: "" }).run()).status, "site_changed");
  assert.equal((await harness("get_fare_options", { ...opts, no_flights: element("We couldn't find an exact match", { getClientRects: () => [] }) }).run()).status, "site_changed");
  assert.equal((await harness("get_fare_options", { ...opts, no_flights: element("We couldn't find an exact match", { css_visible: false }) }).run()).status, "site_changed");
});
test("fare options: pagination rejects non-integers/oversized values before reading", async () => {
  for (const props of [{ offset: -1 }, { offset: 200 }, { offset: "0" }, { limit: 0 }, { limit: 21 }, { limit: 1.2 }]) {
    const h = harness("get_fare_options");
    assert.equal((await h.run({ ...input, ...props })).status, "invalid_input");
    assert.equal(h.reads.length, 0);
  }
});
test("preparation only: rereads exact target, reports incomplete terms and unsupported execution", async () => {
  const h = harness("prepare_itinerary");
  const out = await h.run(choice);
  assert.equal(out.status, "ok");
  assert.equal(out.party_starting_amount, 300);
  assert.equal(out.execution_supported, false);
  assert.equal(out.terms_complete, false);
  assert.match(out.execution_blocker, /trusted human approval/);
  assert.ok(conforms(h.def.tool.outputSchema, out));
  for (const change of [{ expected_amount: 151 }, { offer_id: "row-2" }, { primary_flight: "UA 9999" }, { departure_time: "08:00" }, { arrival_time: "09:00" }, { cabin: "First" }]) assert.equal((await h.run({ ...choice, ...change })).status, "stale_choice");
});
test("preparation rejects connecting/nearby alternatives rather than implying a complete exact itinerary", async () => {
  for (const text of [row().innerText.replace("NONSTOP", "1 STOP"), row().innerText.replace("(LAX)", "(SNA)")]) assert.equal((await harness("prepare_itinerary", { rows: [row({ text })] }).run(choice)).status, "stale_choice");
});
test("preparation rejects malicious and fake confirmation inputs before reading", async () => {
  for (const change of [{ offer_id: "row-0" }, { offer_id: "row-1;fetch()" }, { cabin: "x".repeat(121) }, { expected_amount: NaN }, { expected_amount: Infinity }, { expected_amount: "150" }, { arrival_time: "25:00" }, { confirm: "yes" }, { confirmed: true }]) {
    const h = harness("prepare_itinerary");
    assert.equal((await h.run({ ...choice, ...change })).status, "invalid_input");
    assert.equal(h.reads.length, 0);
  }
});
test("calendar reads dated historical cash cells and schema, without touching controls", async () => {
  const h = harness("get_fare_calendar");
  const out = await h.run();
  assert.equal(out.status, "ok");
  assert.deepEqual(out.days, [{ date: "2027-01-10", amount: 50, currency: "USD", lowest: true }, { date: "2027-01-11", amount: 75, currency: "USD", lowest: false }]);
  assert.ok(conforms(h.def.tool.outputSchema, out));
  assert.equal((await harness("get_fare_calendar", { dialogs: [] }).run()).status, "wrong_page");
});
test("calendar rejects unloaded/malformed/duplicate dates and missing disclaimers", async () => {
  for (const opts of [{ cells: [] }, { cells: Array.from({ length: 63 }, () => cell()) }, { cells: [cell(), cell()] }, { cells: [cell("Depart: Tuesday, Feb 30, 2027  from $50")] }, { cells: [cell("Depart: Sunday, Jan 10, 2027  from €50")] }, { cells: [cell("Depart: Sunday, Jan 10, 2027  from $0")] }, { calendar_terms: "Current fares per person" }]) assert.equal((await harness("get_fare_calendar", opts).run()).status, "site_changed");
  const h = harness("get_fare_calendar");
  assert.equal((await h.run({ ...input, trip_type: "roundtrip", return_date: "2027-01-15" })).status, "invalid_input");
  assert.equal(h.reads.length, 0);
});
test("site text is bounded/sanitized and unrelated account content is not returned", async () => {
  const h = harness("get_fare_options", { terms: terms + "\u202e\u{e0041}" + "x".repeat(2000) });
  const out = await h.run();
  assert.equal(out.terms.length, 1000);
  assert.doesNotMatch(JSON.stringify(out), /\u202e|\u{e0041}/u);
  assert.ok(h.reads.every(s => !/account|passenger|wallet|cookie/i.test(s)));
  assert.doesNotMatch(JSON.stringify(out), /https?:|token|confirmation|passenger_name|account_id/);
});
const chromium = process.env.CHROMIUM_BIN ?? "/usr/bin/chromium";
test("browser DOM: only a visible no-flights notice establishes absence", { skip: !existsSync(chromium) }, () => {
  const dir = mkdtempSync(join(tmpdir(), "united-no-flights-"));
  try {
    const href = "https://www.united.com/en/us/fsr/choose-flights?f=SFO&t=LAX&d=2027-01-10&px=2,0,0,0,0,0,0,0&tqp=R&clm=7&tt=1";
    const html = `<!doctype html><title>Isolated no-flights fixture</title>
      <button aria-label="Currently in English United States $ enter to change">USD</button>
      <select name="FSRSearch.swap0.travelType"><option value="money">Money</option></select>
      <section id="parent"><div id="notice" class="NoFlights-styles__noFlightTitle">We couldn't find an exact match</div></section>
      <pre id="out"></pre><script>
      (async () => {
        const location = ${JSON.stringify({ origin: "https://www.united.com", pathname: "/en/us/fsr/choose-flights", href })};
        const def = (${sources.get_fare_options})[0];
        const notice = document.getElementById("notice"), parent = document.getElementById("parent");
        const cases = ["visible", "visibility:hidden", "visibility:collapse", "display:none", "opacity:0", "parent-hidden"];
        const results = [];
        for (const css of cases) {
          notice.style.cssText = css === "parent-hidden" ? "" : css;
          parent.style.visibility = css === "parent-hidden" ? "hidden" : "visible";
          results.push((await def.execute(${JSON.stringify(input)}, {})).status);
        }
        document.getElementById("out").textContent = JSON.stringify(results);
      })().catch(error => document.getElementById("out").textContent = "ERROR: " + error.message);
      </script>`;
    const file = join(dir, "fixture.html");
    writeFileSync(file, html);
    const run = spawnSync(chromium, ["--headless", "--no-sandbox", "--disable-gpu", "--disable-extensions", "--disable-background-networking", "--no-first-run", `--user-data-dir=${join(dir, "profile")}`, "--dump-dom", `file://${file}`], { encoding: "utf8", timeout: 30000 });
    const diagnostics = `browser=${chromium}; error=${run.error?.message}; signal=${run.signal}; status=${run.status}\nstdout=${run.stdout}\nstderr=${run.stderr}`;
    assert.ok(!run.error, diagnostics);
    assert.equal(run.status, 0, diagnostics);
    const json = run.stdout.match(/<pre id="out">([^<]+)<\/pre>/)?.[1];
    assert.ok(json, diagnostics);
    assert.deepEqual(JSON.parse(json), ["no_results", "site_changed", "site_changed", "site_changed", "site_changed", "site_changed"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
