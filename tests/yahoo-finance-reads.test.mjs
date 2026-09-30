import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const names = ["get_quote", "get_price_history", "search_symbols"];
const sources = Object.fromEntries(names.map(name => [name, readFileSync(new URL(`../domains/yahoo.com/${name}.js`, import.meta.url), "utf8")]));
const plain = value => JSON.parse(JSON.stringify(value));
const symbol = "EXAMPLE";
const marketTime = 1788543000;
const chart = () => ({ chart: { error: null, result: [{
  meta: { symbol, currency: "USD", longName: "Fabricated Company", exchangeName: "NMS", fullExchangeName: "NasdaqGS", instrumentType: "EQUITY", exchangeTimezoneName: "America/New_York", regularMarketTime: marketTime, regularMarketPrice: 11, chartPreviousClose: 10, regularMarketDayHigh: 12, regularMarketDayLow: 9, fiftyTwoWeekHigh: 14, fiftyTwoWeekLow: 5, regularMarketVolume: 1234, dataGranularity: "1d", private_account: "DO_NOT_RETURN" },
  timestamp: [marketTime - 172800, marketTime - 86400, marketTime],
  indicators: { quote: [{ open: [9, 10, 10.5], high: [10, 11, 12], low: [8, 9, 10], close: [9.5, 10.5, 11], volume: [100, 200, 300] }], adjclose: [{ adjclose: [9.4, 10.4, 11] }] }
}] } });
const search = () => ({ quotes: [
  { symbol, longname: "Fabricated Company", quoteType: "EQUITY", exchDisp: "NASDAQ", sector: "Technology", industry: "Fabricated sector", isYahooFinance: true, private_account: "DO_NOT_RETURN" },
  { symbol: "^EXAMPLE", shortname: "Fabricated Index", quoteType: "INDEX", exchange: "NMS", isYahooFinance: true },
  { symbol: "EXAMPLE=X", shortname: "Fabricated Currency", isYahooFinance: true }
], news: [{ uuid: "DO_NOT_RETURN", link: "https://example.test/private?token=DO_NOT_RETURN" }] });

function conforms(schema, value) {
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type && ![schema.type].flat().some(type => type === "null" ? value === null : type === "integer" ? Number.isInteger(value) : type === "array" ? Array.isArray(value) : type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) : typeof value === type)) return false;
  if (schema.oneOf && schema.oneOf.filter(branch => conforms(branch, value)).length !== 1) return false;
  if (typeof value === "string") {
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) return false;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
    if (schema.format === "date-time" && (!Number.isFinite(Date.parse(value)) || !value.endsWith("Z"))) return false;
    if (schema.format === "uri" && !URL.canParse(value)) return false;
  }
  if (typeof value === "number" && (!Number.isFinite(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  if (Array.isArray(value) && (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity) || !value.every(item => conforms(schema.items ?? {}, item)))) return false;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
    if (Object.entries(schema.properties ?? {}).some(([key, rule]) => Object.hasOwn(value, key) && !conforms(rule, value[key]))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(schema.properties ?? {}, key))) return false;
  }
  return true;
}

function harness(name, options = {}) {
  const calls = [];
  const stats = { titleReads: 0, cleared: false, canceled: false, abortSignal: null };
  const currentUrl = options.url ?? "https://finance.yahoo.com/news/";
  const responseBody = options.raw ?? JSON.stringify(options.data ?? (name === "search_symbols" ? search() : chart()));
  const context = {
    URL, URLSearchParams, TextDecoder, AbortController,
    location: new URL(currentUrl),
    document: {
      get title() { stats.titleReads++; return options.title ?? "Yahoo Finance"; },
      querySelector: selector => selector.includes("Consent Management") && options.consent ? { getClientRects: () => options.hiddenConsent ? [] : [{}] } : selector.includes("Sign In Modal") && options.signInModal ? {} : null
    },
    setTimeout: callback => { stats.timer = callback; return 1; },
    clearTimeout: () => { stats.cleared = true; },
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      stats.abortSignal = init.signal;
      assert.equal(init.method, "GET");
      assert.equal(init.credentials, "omit");
      assert.equal(init.redirect, "manual");
      assert.deepEqual(plain(init.headers), { accept: "application/json" });
      assert.equal(new URL(url).origin, "https://query1.finance.yahoo.com");
      assert.ok(!/crumb|token|authorization|cookie/i.test(String(url)));
      if (options.timeout) { stats.timer(); throw new Error("private token DO_NOT_RETURN"); }
      if (options.networkError) throw new Error("private token DO_NOT_RETURN");
      if (init.signal.aborted) throw new Error("aborted");
      let read = false;
      return {
        status: options.status ?? 200, type: options.type ?? "cors", url: options.responseUrl ?? String(url),
        headers: { get: () => options.contentLength ?? null },
        body: { getReader: () => ({ read: async () => {
          if (options.bodyTimeout) { stats.timer(); throw new Error("aborted"); }
          if (read) return { done: true };
          read = true;
          return { done: false, value: new TextEncoder().encode(responseBody) };
        }, cancel: async () => { stats.canceled = true; } }) }
      };
    }
  };
  const [definition] = runInNewContext(`(${sources[name]})`, context);
  return { definition, calls, stats, run: async (input = name === "search_symbols" ? { query: "example" } : { symbol }, signal) => {
    const output = plain(await definition.execute(input, { signal }));
    assert.ok(conforms(definition.tool.outputSchema, output), `${name} schema mismatch: ${JSON.stringify(output)}`);
    assert.ok(!JSON.stringify(output).includes("DO_NOT_RETURN"));
    assert.ok(calls.length <= 1);
    assert.equal(currentUrl, context.location.href);
    return output;
  } };
}

for (const name of names) {
  test(`${name}: page-kind, public-only match, typed schema and safe annotations`, () => {
    const { definition } = harness(name);
    assert.equal(definition.kind, "page");
    assert.deepEqual(plain(definition.match.url_patterns), ["https://finance.yahoo.com/*"]);
    assert.equal(definition.tool.annotations.readOnlyHint, true);
    const keys = schema => [...Object.keys(schema.properties ?? {}), ...Object.values(schema).flatMap(value => value && typeof value === "object" ? (Array.isArray(value) ? value.flatMap(keys) : keys(value)) : [])];
    assert.ok(keys(definition.tool.inputSchema).concat(keys(definition.tool.outputSchema)).every(key => /^[a-z][a-z0-9_]*$/.test(key)));
  });
  test(`${name}: validation precedes every document/network read`, async () => {
    for (const input of [null, [], "x", {}, { bogus: "x" }, name === "search_symbols" ? { query: "" } : { symbol: "https://evil.test/x" }, name === "search_symbols" ? { query: "x\nsecret" } : { symbol: "../account" }]) {
      const h = harness(name);
      assert.equal((await h.run(input)).error_kind, "invalid_input");
      assert.equal(h.calls.length, 0);
      assert.equal(h.stats.titleReads, 0);
    }
  });
  test(`${name}: unrelated or lookalike starting origins make no request`, async () => {
    for (const url of ["https://example.test/", "https://mail.yahoo.com/", "https://finance.yahoo.com.evil.test/", "http://finance.yahoo.com/"]) {
      const h = harness(name, { url });
      assert.equal((await h.run()).error_kind, "wrong_page");
      assert.equal(h.calls.length, 0);
    }
  });
  test(`${name}: visible gates stop before requesting data`, async () => {
    for (const [title, kind] of [["Verify you are human", "challenge"], ["Sign in - Yahoo", "login_required"], ["Consent - Yahoo", "gated"], ["Subscription required", "gated"]]) {
      const h = harness(name, { title });
      assert.equal((await h.run()).error_kind, kind);
      assert.equal(h.calls.length, 0);
    }
  });
  test(`${name}: open consent/login dialogs fail before data access; hidden consent does not block`, async () => {
    for (const [options, kind] of [[{ consent: true }, "gated"], [{ signInModal: true }, "login_required"]]) {
      const h = harness(name, options); assert.equal((await h.run()).error_kind, kind); assert.equal(h.calls.length, 0);
    }
    assert.equal((await harness(name, { consent: true, hiddenConsent: true }).run()).status, "ok");
    assert.equal((await harness(name, { title: "Fabricated Robotics Company - Yahoo Finance" }).run()).status, "ok");
  });
  test(`${name}: HTTP denials never become empty success or retry`, async () => {
    for (const [status, kind] of [[401, "login_required"], [402, "gated"], [403, "forbidden"], [429, "rate_limited"], [500, "site_error"]]) {
      const h = harness(name, { status });
      assert.equal((await h.run()).error_kind, kind);
      assert.equal(h.calls.length, 1);
      assert.equal(h.stats.cleared, true);
      assert.equal(h.stats.abortSignal.aborted, true);
    }
  });
  test(`${name}: redirects, changed origin, non-JSON access walls`, async () => {
    for (const [options, kind] of [[{ type: "opaqueredirect", status: 0 }, "gated"], [{ status: 302 }, "gated"], [{ responseUrl: "https://login.yahoo.com/" }, "gated"], [{ raw: "<html>captcha</html>" }, "challenge"], [{ raw: "<html>Sign in</html>" }, "login_required"], [{ raw: "<html>Premium subscription</html>" }, "gated"], [{ raw: "<html>Unexpected</html>" }, "site_changed"]]) {
      assert.equal((await harness(name, options).run()).error_kind, kind);
    }
  });
  test(`${name}: response size/time/cancellation are bounded and errors sanitized`, async () => {
    assert.equal((await harness(name, { contentLength: "524289" }).run()).error_kind, "site_changed");
    const large = harness(name, { raw: "x".repeat(524289) });
    assert.equal((await large.run()).error_kind, "site_changed");
    assert.equal(large.stats.canceled, true);
    for (const options of [{ timeout: true }, { bodyTimeout: true }]) assert.equal((await harness(name, options).run()).error_kind, "timeout");
    assert.equal((await harness(name, { networkError: true }).run()).error_kind, "network_error");
    const controller = new AbortController(); controller.abort();
    assert.equal((await harness(name).run(undefined, controller.signal)).error_kind, "timeout");
  });
}

test("get_quote: regular-session price, currency, explicit source/observation times, nullable fields", async () => {
  const h = harness("get_quote");
  const r = await h.run({ symbol: "example" });
  assert.equal(r.status, "ok");
  assert.equal(r.symbol, symbol);
  assert.equal(r.currency, "USD");
  assert.equal(r.regular_market_price, 11);
  assert.equal(r.previous_close, 10);
  assert.equal(r.market_time, new Date(marketTime * 1000).toISOString());
  assert.notEqual(r.market_time, r.observed_at);
  assert.match(h.calls[0].url, /range=1d$/);
  const data = chart(); data.chart.result[0].meta.currency = "JPY";
  delete data.chart.result[0].meta.regularMarketDayLow;
  const nonUsd = await harness("get_quote", { data }).run();
  assert.equal(nonUsd.currency, "JPY");
  assert.equal(nonUsd.day_low, null);
});

for (const name of ["get_quote", "get_price_history"]) {
  test(`${name}: known missing-symbol response only, no raw error descriptions`, async () => {
    const r = await harness(name, { status: 404, data: { chart: { result: null, error: { code: "Not Found", description: "DO_NOT_RETURN" } } } }).run();
    assert.equal(r.status, "no_results");
    assert.equal((await harness(name, { status: 404, data: {} }).run()).error_kind, "site_error");
    for (const [code, kind] of [["Unauthorized", "login_required"], ["Forbidden", "forbidden"], ["Too Many Requests", "rate_limited"], ["Premium", "gated"], ["Unknown", "site_error"]]) {
      assert.equal((await harness(name, { data: { chart: { result: null, error: { code, description: "DO_NOT_RETURN" } } } }).run()).error_kind, kind);
    }
  });
  test(`${name}: missing or mismatched public metadata cannot fabricate success`, async () => {
    for (const patch of [{ symbol: "OTHER" }, { currency: null }, { currency: "X".repeat(20) }, { regularMarketTime: null }]) {
      const data = chart(); Object.assign(data.chart.result[0].meta, patch);
      assert.equal((await harness(name, { data }).run()).error_kind, "site_changed");
    }
  });
  test(`${name}: symbols encoded into one fixed-host request and safe canonical URL`, async () => {
    for (const s of ["^EXAMPLE", "EXAMPLE=X", "BRK-B", "7203.T"]) {
      const data = chart(); data.chart.result[0].meta.symbol = s;
      const h = harness(name, { data }); const r = await h.run({ symbol: s });
      assert.equal(r.status, "ok");
      assert.ok(h.calls[0].url.includes(encodeURIComponent(s)));
      assert.equal(new URL(r.url).hostname, "finance.yahoo.com");
    }
  });
}

test("get_price_history: most recent daily candles, UTC timestamps, adjusted close and nulls", async () => {
  const data = chart(); data.chart.result[0].indicators.quote[0].close[0] = null;
  delete data.chart.result[0].indicators.adjclose;
  const h = harness("get_price_history", { data }); const r = await h.run({ symbol, range: "1y", limit: 1 });
  assert.equal(r.status, "ok");
  assert.equal(r.candles.length, 1);
  assert.equal(r.candles[0].timestamp, new Date(marketTime * 1000).toISOString());
  assert.equal(r.candles[0].adjusted_close, null);
  assert.equal(r.total_points, 3);
  assert.equal(r.skipped_points, 1);
  assert.equal(r.truncated, true);
  assert.match(h.calls[0].url, /range=1y$/);
});

test("get_price_history: rejected limits/ranges and damaged arrays", async () => {
  for (const patch of [{ limit: 0 }, { limit: 301 }, { limit: 1.5 }, { range: "max" }, { range: "1m" }, { interval: "1m" }]) {
    const h = harness("get_price_history");
    assert.equal((await h.run({ symbol, ...patch })).error_kind, "invalid_input"); assert.equal(h.calls.length, 0);
  }
  for (const mutate of [r => r.meta.dataGranularity = "1m", r => r.indicators.quote[0].close.pop(), r => r.indicators.adjclose[0].adjclose.pop(), r => r.timestamp = Array(401).fill(marketTime), r => r.timestamp.reverse(), r => r.timestamp = [marketTime, null, marketTime - 1], r => r.indicators.quote[0].close.fill(null)]) {
    const data = chart(); mutate(data.chart.result[0]);
    assert.equal((await harness("get_price_history", { data }).run()).error_kind, "site_changed");
  }
});

test("search_symbols: bounded symbol directory with no news/private fields", async () => {
  const h = harness("search_symbols"); const r = await h.run({ query: "company & type", limit: 1 });
  assert.equal(r.status, "ok"); assert.equal(r.results.length, 1); assert.equal(r.truncated, true);
  assert.equal(r.results[0].symbol, symbol);
  const params = new URL(h.calls[0].url).searchParams;
  assert.equal(params.get("q"), "company & type"); assert.equal(params.get("quotesCount"), "1"); assert.equal(params.get("newsCount"), "0");
  for (const input of [{ query: "x".repeat(81) }, { query: "\ud800" }, { query: "\udc00" }, { query: "\nexample" }, { query: "example\t" }, { query: "x", limit: 11 }, { query: "x", limit: 0 }, { query: "x", limit: "1" }]) {
    const invalid = harness("search_symbols"); assert.equal((await invalid.run(input)).error_kind, "invalid_input"); assert.equal(invalid.calls.length, 0);
  }
});

test("search_symbols: empty, malformed, duplicate and unsafe rows differ", async () => {
  assert.equal((await harness("search_symbols", { data: { quotes: [] } }).run()).status, "no_results");
  for (const data of [{}, { quotes: [{ symbol: "https://evil.test/", isYahooFinance: true }] }, { quotes: [{ symbol, isYahooFinance: false }] }]) assert.equal((await harness("search_symbols", { data }).run()).error_kind, "site_changed");
  const data = search(); data.quotes.push(data.quotes[0]);
  assert.equal((await harness("search_symbols", { data }).run()).results.length, 3);
});

const watchlistSource = readFileSync(new URL("../domains/yahoo.com/get_watchlist.js", import.meta.url), "utf8");
function watchlistHarness(options = {}) {
  const stats = { reads: 0 };
  const fields = ["symbol", "regularMarketPrice", "currency", "regularMarketTime", "quantity"];
  const fieldList = options.fields ?? fields;
  const headers = fieldList.map(field => ({ getAttribute: () => field }));
  const data = options.rows ?? ["EXAMPLE", "^EXAMPLE", "EXAMPLE=X"];
  const rowNodes = data.map((s, index) => ({
    getClientRects: () => options.hiddenRows?.includes(index) ? [] : [{}],
    visibility: options.invisibleRows?.includes(index) ? "hidden" : "visible",
    querySelectorAll: () => fieldList.map(field => {
      const content = { symbol: s, regularMarketPrice: "10.50", currency: "USD", regularMarketTime: "4:00 PM EDT", quantity: "DO_NOT_RETURN" }[field] ?? "";
      return {
        textContent: content,
        querySelector: selector => field === "symbol" && selector === 'a[href^="/quote/"]' ? { textContent: s, getAttribute: () => options.badLink ? "/quote/OTHER/" : "/quote/" + encodeURIComponent(s) + "/" }
          : field === "regularMarketTime" && !options.noTime ? { getAttribute: () => options.badTime ? "unknown" : String(marketTime + index) } : null
      };
    })
  }));
  const table = {
    querySelector: () => fieldList.includes("symbol") ? {} : null,
    querySelectorAll: selector => selector === "thead th" ? headers : selector === "tbody tr" ? rowNodes : []
  };
  const context = {
    URL, getComputedStyle: row => ({ visibility: row.visibility }), location: new URL(options.url ?? "https://finance.yahoo.com/portfolio/p_0/view/v1"),
    document: {
      get title() { stats.reads++; return options.title ?? "My Watchlist - Yahoo Finance"; },
      querySelector: selector => { stats.reads++; return selector.includes("Consent Management") && options.consent ? { getClientRects: () => options.hiddenConsent ? [] : [{}] } : selector.includes("Sign In Modal") && options.signInModal ? {} : null; },
      querySelectorAll: selector => { stats.reads++; return selector === "h1,h2" ? [{ textContent: options.heading ?? "My Watchlist" }] : selector === "table" ? (options.noTable ? [] : options.ambiguous ? [table, table] : [table]) : []; }
    },
    fetch: () => { assert.fail("watchlist must not fetch"); },
    click: () => { assert.fail("watchlist must not click"); }
  };
  const [definition] = runInNewContext(`(${watchlistSource})`, context);
  return { definition, stats, run: async (input = {}, signal) => {
    const result = plain(await definition.execute(input, { signal }));
    assert.ok(conforms(definition.tool.outputSchema, result), JSON.stringify(result));
    assert.ok(!JSON.stringify(result).includes("DO_NOT_RETURN"));
    return result;
  } };
}

test("get_watchlist: current-document authorized read, market time, bounds, no holdings", async () => {
  const h = watchlistHarness(); const r = await h.run({ watchlist_id: "p_0", limit: 1 });
  assert.equal(h.definition.kind, "page");
  assert.equal(r.status, "ok"); assert.equal(r.rows.length, 1); assert.equal(r.total_visible_rows, 3); assert.equal(r.truncated, true);
  assert.equal(r.rows[0].symbol, "EXAMPLE"); assert.equal(r.rows[0].last_price_text, "10.50"); assert.equal(r.rows[0].currency, "USD");
  assert.equal(r.rows[0].market_time, new Date(marketTime * 1000).toISOString());
  assert.equal((await watchlistHarness({ noTime: true }).run()).rows[0].market_time, null);
  assert.equal((await watchlistHarness({ badTime: true }).run()).rows[0].market_time, null);
});

test("get_watchlist: hidden rows are excluded before limits and visible counts", async () => {
  const r = await watchlistHarness({ hiddenRows: [0], invisibleRows: [1] }).run({ limit: 1 });
  assert.equal(r.total_visible_rows, 1); assert.equal(r.rows[0].symbol, "EXAMPLE=X"); assert.equal(r.truncated, false);
  assert.equal((await watchlistHarness({ hiddenRows: [0, 1, 2] }).run()).error_kind, "site_changed");
});

test("get_watchlist: validation/cancellation before any account/document inspection", async () => {
  for (const input of [null, [], { limit: 0 }, { limit: 51 }, { limit: 1.5 }, { watchlist_id: "p_123" }, { account_id: "DO_NOT_RETURN" }]) {
    const h = watchlistHarness(); assert.equal((await h.run(input)).error_kind, "invalid_input"); assert.equal(h.stats.reads, 0);
  }
  const controller = new AbortController(); controller.abort();
  const h = watchlistHarness(); assert.equal((await h.run({}, controller.signal)).error_kind, "canceled"); assert.equal(h.stats.reads, 0);
});

test("get_watchlist: wrong origin/view, loading, gates and malformed targets fail closed", async () => {
  for (const [options, kind] of [
    [{ url: "https://mail.yahoo.com/" }, "wrong_page"], [{ url: "https://finance.yahoo.com/quote/EXAMPLE/" }, "wrong_page"],
    [{ url: "https://finance.yahoo.com/portfolio/p_123/view/v1" }, "wrong_watchlist"], [{ title: "Sign in - Yahoo" }, "login_required"],
    [{ title: "Verify you are human" }, "challenge"], [{ title: "Consent" }, "gated"], [{ consent: true }, "gated"], [{ signInModal: true }, "login_required"], [{ heading: "A different list" }, "site_changed"],
    [{ rows: [] }, "site_changed"], [{ fields: ["symbol"] }, "site_changed"], [{ noTable: true }, "site_changed"],
    [{ ambiguous: true }, "site_changed"], [{ rows: ["https://evil.test/"] }, "site_changed"], [{ badLink: true }, "site_changed"]
  ]) assert.equal((await watchlistHarness(options).run()).error_kind, kind);
});

test("get_watchlist: bounded large table; schema keys are snake_case", async () => {
  const h = watchlistHarness({ rows: Array(51).fill("EXAMPLE") }); const r = await h.run({ limit: 50 });
  assert.equal(r.rows.length, 50); assert.equal(r.truncated, true);
  assert.equal((await watchlistHarness({ rows: Array(1001).fill("EXAMPLE") }).run()).error_kind, "site_changed");
  const keys = schema => [...Object.keys(schema.properties ?? {}), ...Object.values(schema).flatMap(value => value && typeof value === "object" ? (Array.isArray(value) ? value.flatMap(keys) : keys(value)) : [])];
  assert.ok(keys(h.definition.tool.inputSchema).concat(keys(h.definition.tool.outputSchema)).every(key => /^[a-z][a-z0-9_]*$/.test(key)));
});
