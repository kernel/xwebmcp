import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

// Harness for the cloudflare.com Radar tools. Every page request is stubbed and nothing here contacts the live site.
// Outages, anomalies, domains, ASNs and DNS records below are fabricated.
const NAMES = ["list_internet_outages", "get_domain_info"];
const sources = Object.fromEntries(NAMES.map(name => [name, readFileSync(new URL(`../domains/cloudflare.com/${name}.js`, import.meta.url), "utf8")]));
const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
const plain = value => JSON.parse(JSON.stringify(value));
const ORIGIN = "https://radar.cloudflare.com";

function conforms(schema, value) {
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type && ![schema.type].flat().some(type => {
    if (type === "null") return value === null;
    if (type === "integer") return Number.isInteger(value);
    if (type === "array") return Array.isArray(value);
    if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    return typeof value === type;
  })) return false;
  if (schema.oneOf && schema.oneOf.filter(s => conforms(s, value)).length !== 1) return false;
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.items && !value.every(item => conforms(schema.items, item))) return false;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
    if (schema.properties) {
      if (Object.entries(schema.properties).some(([key, s]) => key in value && !conforms(s, value[key]))) return false;
      if (schema.additionalProperties === false && Object.keys(value).some(key => !(key in schema.properties))) return false;
    }
  }
  if (typeof value === "string") {
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) return false;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
    if (schema.format === "uri" && !URL.canParse(value)) return false;
  }
  if (typeof value === "number") {
    if (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) return false;
  }
  return true;
}

// --- fabricated site data ---------------------------------------------------------------------------

const outage = (id, start, extra = {}) => ({
  id, dataSource: "ALL", description: "Fabricated outage " + id, tags: [], scope: null, startDate: start, endDate: "2026-09-20T12:00:00Z",
  locations: ["XA"], asns: [64500], geoIds: ["1"], origins: [], entities: [{ entityType: "LOCATION", entityValue: "XA", entityName: "Exampleland" }],
  eventType: "OUTAGE", linkedUrl: null,
  asnsDetails: [{ asn: "64500", name: "EXAMPLE-NET", location: { code: "XA", name: "Exampleland" } }],
  locationsDetails: [{ name: "Exampleland", code: "XA" }], originsDetails: [],
  outage: { outageCause: "POWER_OUTAGE", outageType: "NATIONWIDE" }, internalNote: "must not leave the page", ...extra
});
const anomaly = (uuid, start, extra = {}) => ({
  visibleInDataSources: ["NET", "HTTP"], uuid, type: "LOCATION", status: "UNVERIFIED", startDate: start, endDate: "2026-09-20T03:00:00Z",
  locationDetails: { code: "XB", name: "Otherland" }, asnDetails: null, originDetails: null, internalNote: "must not leave the page", ...extra
});
const outageBody = (o = {}) => ({
  state: { location: { type: "global" }, dateRange: "7d", params: {} },
  outages: [outage("9001", "2026-09-19T10:00:00Z"), outage("9003", "2026-09-21T10:00:00Z"), outage("9002", "2026-09-20T10:00:00Z")],
  anomalies: [anomaly("a-1", "2026-09-18T01:00:00Z"), anomaly("a-2", "2026-09-22T01:00:00Z", { endDate: null, type: "AS", locationDetails: null, asnDetails: { asn: "64501", name: "OTHER-NET", location: { code: "XB", name: "Otherland" } } })],
  ...o
});

const details = (o = {}) => ({ categories: [{ label: ["Technology", { ns: "intel" }] }, { label: ["News & Media", { ns: "intel" }] }], asn: { asn: 64500, name: "EXAMPLE-NET", country: "XA" }, ranking: { dataset: null, trendingToday: false, trendingWeek: false }, dnssec: true, token: "must not leave the page", ...o });
const dnsRecords = [
  { type: "A", name: "host.example.net", data: "192.0.2.1" }, { type: "A", name: "host.example.net", data: "192.0.2.2" }, { type: "AAAA", name: "host.example.net", data: "2001:db8::1" },
  { type: "TXT", name: "host.example.net", data: "\"v=spf1 -all\"" }, { type: "TXT", name: "host.example.net", data: "x".repeat(700) }
];
const top100 = { domains: [{ rank: 1, domain: "first.example.net", categories: [] }, { rank: 2, domain: "host.example.net", categories: [] }], lastUpdate: "2026-09-29" };
const whois = { punycode: "host.example.net", created_date: "2001-01-02T00:00:00.000Z", updated_date: "2025-03-04T00:00:00.000Z", expiration_date: "2030-01-02T00:00:00.000Z", registrar: "Example Registrar, Inc.", nameservers: ["ns1.host.example.net", "ns2.host.example.net"], dnssec: false, status: ["clienttransferprohibited"], registrantName: "must not leave the page" };

// --- harness ------------------------------------------------------------------------------------------

function harness(name, o = {}) {
  const calls = { fetches: [] };
  const routes = {
    "OutagesMap": () => ({ status: 200, body: outageBody() }),
    "DomainDetailsPanel": () => ({ status: 200, body: details() }),
    "DnsRecordsTable": () => ({ status: 200, body: { records: dnsRecords } }),
    "DomainPqSupport": () => ({ status: 200, body: { pq: true, kexName: "X25519MLKEM768", error: null } }),
    "WhoisPanel": () => ({ status: 200, body: whois }),
    "TopDomainsTable": () => ({ status: 200, body: top100 }),
    ...(o.routes ?? {})
  };
  const pageContext = {
    JSON, URL, URLSearchParams, TextEncoder, Promise, Intl, Math, Date, Number, Object, Array, String, RegExp, Map, Set, Error, encodeURIComponent, isFinite, Infinity, NaN,
    window: { location: { origin: o.origin ?? ORIGIN } },
    fetch: async (path, init = {}) => {
      calls.fetches.push({ path, init });
      assert.ok(path.startsWith("/charts/"), "only Radar's same-origin chart endpoints may be called: " + path);
      assert.equal(init.method, undefined, "only GET requests");
      assert.equal(init.credentials, undefined, "no credentials override needed for same-origin GETs");
      const chart = /^\/charts\/([A-Za-z]+)\/fetch\?/.exec(path)?.[1];
      const r = await (routes[chart] ?? (() => ({ status: 404, text: "Not Found" })))(path);
      const headers = { "retry-after": null, "cf-mitigated": null, ...(r.headers ?? {}) };
      return { status: r.status, headers: { get: k => headers[k.toLowerCase()] ?? null }, text: async () => (r.text ?? JSON.stringify(r.body)) };
    }
  };
  const [definition] = runInNewContext(`(${sources[name]})`, pageContext);
  return {
    definition, calls,
    run: async (input, context) => {
      const result = plain(await definition.execute(input, context));
      assert.ok(conforms(definition.tool.outputSchema, result), `${name} output violates its schema: ${JSON.stringify(result)}`);
      const text = JSON.stringify(result);
      assert.ok(!text.includes("must not leave the page"), "fields outside the allowlist must not be returned");
      return result;
    }
  };
}
const queryOf = call => Object.fromEntries(new URLSearchParams(call.path.split("?")[1]));

// --- structure ----------------------------------------------------------------------------------------

for (const name of NAMES) {
  test(`${name}: single-expression page tool with typed schemas and a registry entry`, () => {
    assert.equal(sources[name].trimEnd().endsWith(";"), false);
    assert.equal(/\b(Buffer|require|process)\b/.test(sources[name]), false, "tool source must not depend on Node globals");
    assert.equal(/\b(js|gotoUrl|pageInfo|waitForLoad|accessibilitySnapshot|click|pressKey|fillInput|typeText)\(/.test(sources[name]), false, "page tools cannot use runtime helpers");
    assert.equal(/location\.(assign|replace|href\s*=)|\.submit\(|window\.open|method:\s*["']POST|method:\s*["']PUT|method:\s*["']DELETE/i.test(sources[name]), false, "tools never navigate or send non-GET requests");
    assert.equal(/\/scan|\/api\/|dash\.cloudflare|api\.cloudflare/.test(sources[name]), false, "tools only use Radar's chart endpoints");
    const { definition } = harness(name);
    assert.equal(definition.tool.name, name);
    assert.equal(definition.kind, "page");
    assert.deepEqual(plain(definition.match.url_patterns), ["https://radar.cloudflare.com/*"]);
    assert.equal(definition.tool.inputSchema.type, "object");
    assert.equal(definition.tool.inputSchema.additionalProperties, false);
    assert.equal(definition.tool.outputSchema.type, "object");
    assert.equal(definition.tool.annotations.readOnlyHint, true);
    assert.equal(definition.tool.annotations.destructiveHint, false);
    assert.equal(definition.tool.annotations.untrustedContentHint, true);
    const entry = registry.tools.find(t => t.domain === "cloudflare.com" && t.tool === name);
    assert.ok(entry, "registry entry missing");
    assert.equal(entry.file, `domains/cloudflare.com/${name}.js`);
    assert.equal(entry.kind, "page");
    assert.deepEqual(entry.url_patterns, plain(definition.match.url_patterns));
  });
}

test("registry lists every cloudflare.com tool exactly once", () => {
  assert.deepEqual(registry.tools.filter(t => t.domain === "cloudflare.com").map(t => t.tool).sort(), [...NAMES].sort());
});

test("tool names do not collide with Radar's native tools", () => {
  const native = ["get-current-view", "navigate-to", "search", "set-date-range", "set-location", "set-theme", "read-page"];
  for (const name of NAMES) assert.equal(native.includes(name), false);
});

// --- input validation happens before any request ---------------------------------------------------------

const invalidInputs = {
  list_internet_outages: [null, [], "US", { extra: 1 }, { location: "" }, { location: "united states" }, { location: "USA" }, { location: "AS12345678901" }, { location: "AS4294967296" }, { location: "AS9999999999" }, { location: "AS0" }, { location: "AS013335" }, { location: "antarctica" }, { location: "Europe" }, { location: "europe" }, { location: "north-america" }, { location: 5 },
    { date_range: "5d" }, { date_range: 7 }, { date_range: "7d", date_start: "2026-09-01", date_end: "2026-09-02" }, { date_start: "2026-09-01" }, { date_end: "2026-09-02" },
    { date_start: "2026-02-30", date_end: "2026-03-01" }, { date_start: "2026-13-01", date_end: "2026-13-05" }, { date_start: "2026-01-00", date_end: "2026-01-05" }, { date_start: "2026-01-01", date_end: "2026-00-10" }, { date_start: "09/01/2026", date_end: "09/02/2026" }, { date_start: "2026-09-05", date_end: "2026-09-01" }, { date_start: "2025-01-01", date_end: "2026-06-01" },
    { include: "all" }, { limit: 0 }, { limit: 51 }, { limit: 2.5 }, { limit: "5" }],
  get_domain_info: [undefined, null, [], {}, "example.com", { domain: 5 }, { domain: "" }, { domain: "example" }, { domain: "localhost" }, { domain: "1.1.1.1" }, { domain: "http://example.com" }, { domain: "example.com/path" },
    { domain: "example.com:443" }, { domain: "example.com." }, { domain: "exa mple.com" }, { domain: "-bad.example.com" }, { domain: "bücher.example.com" }, { domain: "x".repeat(64) + ".com" }, { domain: "a.".repeat(130) + "com" },
    { domain: "host.invalid" }, { domain: "host.test" }, { domain: "host.local" }, { domain: "host.onion" }, { domain: "example.com", extra: 1 },
    { domain: "example.com", sections: [] }, { domain: "example.com", sections: "details" }, { domain: "example.com", sections: ["details", "details"] }, { domain: "example.com", sections: ["tls"] },
    { domain: "example.com", dns_record_limit: 0 }, { domain: "example.com", dns_record_limit: 201 }, { domain: "example.com", dns_record_limit: 1.5 }]
};
for (const [name, inputs] of Object.entries(invalidInputs)) {
  for (const input of inputs) {
    test(`${name}: rejects ${JSON.stringify(input)} before any request`, async () => {
      const h = harness(name);
      const result = await h.run(input);
      assert.equal(result.status, "error");
      assert.equal(result.error_kind, "invalid_input");
      assert.deepEqual(h.calls.fetches, []);
    });
  }
}

for (const name of NAMES) {
  test(`${name}: refuses to run outside radar.cloudflare.com`, async () => {
    for (const origin of ["https://www.cloudflare.com", "https://developers.cloudflare.com", "http://radar.cloudflare.com", "about:blank"]) {
      const h = harness(name, { origin });
      const result = await h.run(name === "get_domain_info" ? { domain: "host.example.net" } : {});
      assert.equal(result.error_kind, "wrong_page", origin);
      assert.deepEqual(h.calls.fetches, []);
    }
  });
}

// --- list_internet_outages -----------------------------------------------------------------------------

test("list_internet_outages: default request, allowlisted fields, newest first", async () => {
  const h = harness("list_internet_outages");
  const result = await h.run({});
  assert.equal(h.calls.fetches.length, 1);
  assert.equal(h.calls.fetches[0].path, "/charts/OutagesMap/fetch?dateRange=7d");
  assert.equal(result.status, "ok");
  assert.equal(result.source_url, "https://radar.cloudflare.com/outage-center");
  assert.deepEqual(result.applied, { location: { type: "global", id: null, name: null }, date_range: "7d", date_start: null, date_end: null });
  assert.deepEqual(result.outages.map(o => o.id), ["9003", "9002", "9001"]);
  assert.deepEqual(result.anomalies.map(a => a.id), ["a-2", "a-1"]);
  assert.equal(result.outages_total, 3);
  assert.equal(result.anomalies_total, 2);
  assert.equal(result.untrusted_content, true);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.outages[0], {
    id: "9003", description: "Fabricated outage 9003", cause: "POWER_OUTAGE", outage_type: "NATIONWIDE", scope: null, data_source: "ALL", start_utc: "2026-09-21T10:00:00Z", end_utc: "2026-09-20T12:00:00Z",
    locations: [{ code: "XA", name: "Exampleland" }], asns: [{ asn: 64500, name: "EXAMPLE-NET", country_code: "XA" }], origins: [], linked_url: null, tags: []
  });
  assert.deepEqual(result.anomalies[0], { id: "a-2", type: "AS", status: "UNVERIFIED", data_sources: ["NET", "HTTP"], start_utc: "2026-09-22T01:00:00Z", end_utc: null, location: null, asn: { asn: 64501, name: "OTHER-NET", country_code: "XB" } });
  assert.deepEqual(result.anomalies[1].location, { code: "XB", name: "Otherland" });
});

test("list_internet_outages: filters go to the site as Radar's own query parameters", async () => {
  for (const [input, expected, state] of [
    [{ location: "US" }, { location: "us", dateRange: "7d" }, { location: { type: "country", code: "US", name: "United States" }, dateRange: "7d" }],
    [{ location: "As13335", date_range: "28d" }, { location: "as13335", dateRange: "28d" }, { location: { type: "asn", asn: "13335" }, dateRange: "28d" }],
    [{ date_start: "2026-09-01", date_end: "2026-09-15" }, { dateStart: "2026-09-01", dateEnd: "2026-09-15" }, { location: { type: "global" }, dateRange: "", dateStart: "2026-09-01", dateEnd: "2026-09-15" }]
  ]) {
    const h = harness("list_internet_outages", { routes: { OutagesMap: () => ({ status: 200, body: outageBody({ state: { ...state, params: {} } }) }) } });
    const result = await h.run(input);
    assert.equal(result.status, "ok", JSON.stringify(input));
    assert.deepEqual(queryOf(h.calls.fetches[0]), expected);
  }
});

test("list_internet_outages: include and limit bound the output and say what was cut", async () => {
  const many = Array.from({ length: 30 }, (_, i) => outage(String(1000 + i), `2026-09-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00Z`));
  const h = harness("list_internet_outages", { routes: { OutagesMap: () => ({ status: 200, body: outageBody({ outages: many }) }) } });
  const some = await h.run({ include: "outages", limit: 5 });
  assert.equal(some.outages.length, 5);
  assert.equal(some.outages_total, 30);
  assert.equal(some.anomalies_total, null);
  assert.deepEqual(some.anomalies, []);
  assert.ok(some.warnings.some(w => /5 of 30 outages/.test(w)));
  const onlyAnomalies = await h.run({ include: "anomalies" });
  assert.deepEqual(onlyAnomalies.outages, []);
  assert.equal(onlyAnomalies.outages_total, null);
  assert.equal(onlyAnomalies.anomalies.length, 2);
  const dflt = await h.run({});
  assert.equal(dflt.outages.length, 20);
});

test("list_internet_outages: text is bounded and only https links survive", async () => {
  const body = outageBody({ outages: [
    outage("1", "2026-09-19T10:00:00Z", { description: "d".repeat(900), linkedUrl: "https://example.org/status/1" }),
    outage("2", "2026-09-18T10:00:00Z", { linkedUrl: "javascript:alert(1)" }),
    outage("3", "2026-09-17T10:00:00Z", { linkedUrl: "http://example.org/plain" }),
    outage("4", "2026-09-16T10:00:00Z", { endDate: null, tags: ["a", 5, ""], originsDetails: [{ name: "Example Cloud", origin: "example-cloud-1" }, { name: "no id" }] })
  ] });
  const result = await harness("list_internet_outages", { routes: { OutagesMap: () => ({ status: 200, body }) } }).run({});
  assert.equal(result.outages[0].description.length, 500);
  assert.equal(result.outages[0].linked_url, "https://example.org/status/1");
  assert.equal(result.outages[1].linked_url, null);
  assert.equal(result.outages[2].linked_url, null);
  assert.equal(result.outages[3].end_utc, null);
  assert.deepEqual(result.outages[3].tags, ["a"]);
  assert.deepEqual(result.outages[3].origins, [{ id: "example-cloud-1", name: "Example Cloud" }]);
  const odd = outageBody({ outages: [outage("5", "2026-09-15T10:00:00Z", { asnsDetails: [{ asn: null, name: "no number" }, { asn: "", name: "empty" }, { asn: "64502", name: "OK-NET", location: null }], locationsDetails: [null, { code: "XA" }] })] });
  const oddResult = await harness("list_internet_outages", { routes: { OutagesMap: () => ({ status: 200, body: odd }) } }).run({ include: "outages" });
  assert.deepEqual(oddResult.outages[0].asns, [{ asn: 64502, name: "OK-NET", country_code: null }]);
  assert.deepEqual(oddResult.outages[0].locations, [{ code: "XA", name: null }]);
});

test("list_internet_outages: items in an unexpected shape are dropped and reported, or fail loudly when none remain", async () => {
  const partial = outageBody({ outages: [outage("1", "2026-09-19T10:00:00Z"), { id: 5 }, null], anomalies: [{ uuid: "x" }] });
  const result = await harness("list_internet_outages", { routes: { OutagesMap: () => ({ status: 200, body: partial }) } }).run({});
  assert.equal(result.status, "ok");
  assert.equal(result.outages.length, 1);
  assert.ok(result.warnings.some(w => /3 item\(s\) were dropped/.test(w)));
  const broken = outageBody({ outages: [{ id: 5 }], anomalies: [{ uuid: "x" }] });
  const failed = await harness("list_internet_outages", { routes: { OutagesMap: () => ({ status: 200, body: broken }) } }).run({});
  assert.equal(failed.error_kind, "site_changed");
});

test("list_internet_outages: an empty window is no_results, not an empty success", async () => {
  const h = harness("list_internet_outages", { routes: { OutagesMap: () => ({ status: 200, body: outageBody({ outages: [], anomalies: [] }) }) } });
  const result = await h.run({});
  assert.equal(result.status, "no_results");
  assert.equal(result.applied.date_range, "7d");
  const onlyOutages = await harness("list_internet_outages", { routes: { OutagesMap: () => ({ status: 200, body: outageBody({ outages: [] }) }) } }).run({ include: "outages" });
  assert.equal(onlyOutages.status, "no_results");
});

test("list_internet_outages: site failures are explicit errors", async () => {
  const cases = [
    [{ status: 429, text: '{"error":"rate limited"}', headers: { "retry-after": "120" } }, "rate_limited", 120],
    [{ status: 429, text: "slow down" }, "rate_limited", null],
    [{ status: 403, text: "<html>Just a moment...</html>" }, "challenge", undefined],
    [{ status: 503, text: "", headers: { "cf-mitigated": "challenge" } }, "challenge", undefined],
    [{ status: 500, text: "Error fetching data" }, "site_error", undefined],
    [{ status: 403, text: "forbidden" }, "site_error", undefined],
    [{ status: 200, text: "<html>not json</html>" }, "site_changed", undefined],
    [{ status: 200, body: { outages: [], anomalies: [] } }, "site_changed", undefined],
    [{ status: 200, body: { state: {}, outages: {}, anomalies: [] } }, "site_changed", undefined]
  ];
  for (const [response, kind, retry] of cases) {
    const result = await harness("list_internet_outages", { routes: { OutagesMap: () => response } }).run({});
    assert.equal(result.status, "error", JSON.stringify(response));
    assert.equal(result.error_kind, kind, JSON.stringify(response));
    assert.equal(result.retry_after_seconds, retry, JSON.stringify(response));
  }
  const notSupported = await harness("list_internet_outages", { routes: { OutagesMap: () => ({ status: 404, text: "Location not supported" }) } }).run({ location: "zz" });
  assert.equal(notSupported.error_kind, "location_not_supported");
  const thrown = await harness("list_internet_outages", { routes: { OutagesMap: () => { throw new Error("network down"); } } }).run({});
  assert.equal(thrown.error_kind, "site_error");
  assert.match(thrown.error_message, /no automatic retry/);
});

test("list_internet_outages: a filter the site did not apply is reported as site_changed, never trusted", async () => {
  const wrongRange = await harness("list_internet_outages", { routes: { OutagesMap: () => ({ status: 200, body: outageBody() }) } }).run({ date_range: "28d" });
  assert.equal(wrongRange.error_kind, "site_changed");
  const wrongLocation = await harness("list_internet_outages", { routes: { OutagesMap: () => ({ status: 200, body: outageBody() }) } }).run({ location: "US" });
  assert.equal(wrongLocation.error_kind, "site_changed");
  const wrongAsn = await harness("list_internet_outages", { routes: { OutagesMap: () => ({ status: 200, body: outageBody({ state: { location: { type: "asn", asn: "13335" }, dateRange: "7d" } }) }) } }).run({ location: "AS64500" });
  assert.equal(wrongAsn.error_kind, "site_changed");
  const unrequested = await harness("list_internet_outages", { routes: { OutagesMap: () => ({ status: 200, body: outageBody({ state: { location: { type: "country", code: "US", name: "United States" }, dateRange: "7d" } }) }) } }).run({});
  assert.equal(unrequested.error_kind, "site_changed");
  const wrongDates = await harness("list_internet_outages", { routes: { OutagesMap: () => ({ status: 200, body: outageBody({ state: { location: { type: "global" }, dateRange: "7d", dateStart: "2026-09-02", dateEnd: "2026-09-03" } }) }) } }).run({ date_start: "2026-09-01", date_end: "2026-09-03" });
  assert.equal(wrongDates.error_kind, "site_changed");
});

// --- get_domain_info ------------------------------------------------------------------------------------

const chartsCalled = h => h.calls.fetches.map(f => /^\/charts\/([A-Za-z]+)\//.exec(f.path)[1]);

test("get_domain_info: default sections read details, DNS and post-quantum support, not WHOIS", async () => {
  const h = harness("get_domain_info");
  const result = await h.run({ domain: "  Host.Example.NET  " });
  assert.deepEqual(chartsCalled(h), ["DomainDetailsPanel", "TopDomainsTable", "DnsRecordsTable", "DomainPqSupport"]);
  assert.equal(h.calls.fetches[0].path, "/charts/DomainDetailsPanel/fetch?domain=host.example.net");
  assert.equal(result.status, "ok");
  assert.equal(result.domain, "host.example.net");
  assert.equal(result.source_url, "https://radar.cloudflare.com/domains/domain/host.example.net");
  assert.deepEqual(result.requested_sections, ["details", "dns", "pq"]);
  assert.deepEqual(result.details, { categories: ["Technology", "News & Media"], asn: { asn: 64500, name: "EXAMPLE-NET", country_code: "XA" }, dnssec: true, top_100_rank: 2 });
  assert.deepEqual(result.pq_support, { supported: true, key_exchange: "X25519MLKEM768" });
  assert.equal(result.whois, null);
  assert.deepEqual(result.unavailable, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.untrusted_content, true);
});

test("get_domain_info: normalized empty categories and ASN cannot produce an empty details success", async () => {
  for (const [categories, asn] of [[null, {}], [[], null], [[{}], {}], [[{ label: [""] }], { asn: 0 }], [null, { asn: 4294967296 }]]) {
    const h = harness("get_domain_info", { routes: { DomainDetailsPanel: () => ({ status: 200, body: { categories, asn, dnssec: false } }) } });
    assert.equal((await h.run({ domain: "host.example.net", sections: ["details"] })).status, "no_data");
    assert.deepEqual(chartsCalled(h), ["DomainDetailsPanel"]);
  }
  const h = harness("get_domain_info", { routes: { DomainDetailsPanel: () => ({ status: 200, body: details({ categories: null }) }) } });
  assert.equal((await h.run({ domain: "host.example.net", sections: ["details"] })).details.asn.asn, 64500);
});

test("get_domain_info: the Top 100 position needs an exact name match", async () => {
  for (const [domain, rank] of [["host.example.net", 2], ["www.host.example.net", null], ["other.example.net", null]]) {
    const result = await harness("get_domain_info").run({ domain, sections: ["details"] });
    assert.equal(result.details.top_100_rank, rank, domain);
  }
  const unreadable = await harness("get_domain_info", { routes: { TopDomainsTable: () => ({ status: 500, text: "boom" }) } }).run({ domain: "host.example.net", sections: ["details"] });
  assert.equal(unreadable.status, "ok");
  assert.equal(unreadable.details.top_100_rank, null);
  assert.ok(unreadable.warnings.some(w => /Top 100 table could not be read/.test(w)));
});

test("get_domain_info: DNS records are bounded and long data is cut", async () => {
  const h = harness("get_domain_info");
  const limited = await h.run({ domain: "host.example.net", sections: ["dns"], dns_record_limit: 2 });
  assert.equal(limited.dns_records.total, 5);
  assert.equal(limited.dns_records.records.length, 2);
  assert.equal(limited.dns_records.truncated, true);
  const all = await h.run({ domain: "host.example.net", sections: ["dns"] });
  assert.equal(all.dns_records.records.length, 5);
  assert.equal(all.dns_records.records[4].data.length, 512);
  assert.equal(all.dns_records.truncated, true);
  const small = await harness("get_domain_info", { routes: { DnsRecordsTable: () => ({ status: 200, body: { records: dnsRecords.slice(0, 3) } }) } }).run({ domain: "host.example.net", sections: ["dns"] });
  assert.equal(small.dns_records.truncated, false);
  const mixed = await harness("get_domain_info", { routes: { DnsRecordsTable: () => ({ status: 200, body: { records: [{ type: "A", name: "host.example.net", data: "192.0.2.1" }, { type: "A" }, null] } }) } }).run({ domain: "host.example.net", sections: ["dns"] });
  assert.equal(mixed.dns_records.total, 1);
});

test("get_domain_info: root-zone answers for unassigned names are not DNS records, CNAME chains are kept", async () => {
  const root = { records: ["a", "b", "c"].map(x => ({ type: "NS", name: "", data: x + ".root-servers.net." })) };
  const unassigned = await harness("get_domain_info", { routes: { DnsRecordsTable: () => ({ status: 200, body: root }) } }).run({ domain: "printer.lan", sections: ["dns"] });
  assert.equal(unassigned.status, "no_data");
  assert.equal(unassigned.unavailable[0].section, "dns");
  const chain = { records: [{ type: "CNAME", name: "www.host.example.net", data: "edge.cdn.example.net." }, { type: "CNAME", name: "edge.cdn.example.net", data: "node1.cdn.example.net." }, { type: "A", name: "node1.cdn.example.net", data: "192.0.2.9" }, ...root.records] };
  const kept = await harness("get_domain_info", { routes: { DnsRecordsTable: () => ({ status: 200, body: chain }) } }).run({ domain: "www.host.example.net", sections: ["dns"] });
  assert.equal(kept.dns_records.total, 3);
  assert.deepEqual(kept.dns_records.records.map(r => r.name), ["www.host.example.net", "edge.cdn.example.net", "node1.cdn.example.net"]);
});

test("get_domain_info: a valid but falsy JSON body is a shape change, not an empty success", async () => {
  for (const body of [false, 0, "", []]) {
    for (const [route, section] of [["DomainDetailsPanel", "details"], ["DnsRecordsTable", "dns"], ["DomainPqSupport", "pq"], ["WhoisPanel", "whois"]]) {
      const result = await harness("get_domain_info", { routes: { [route]: () => ({ status: 200, text: JSON.stringify(body) }) } }).run({ domain: "host.example.net", sections: [section] });
      assert.equal(result.status, "error", route + " " + JSON.stringify(body));
      assert.equal(result.error_kind, "site_changed", route + " " + JSON.stringify(body));
    }
  }
});

test("get_domain_info: malformed nameserver entries cannot produce an empty WHOIS success", async () => {
  for (const nameservers of [[null], [false], [{}], [""], [null, false, {}, ""]]) {
    const h = harness("get_domain_info", { routes: { WhoisPanel: () => ({ status: 200, body: { nameservers } }) } });
    const result = await h.run({ domain: "host.example.net", sections: ["whois"] });
    assert.equal(result.status, "no_data");
    assert.equal(result.unavailable[0].kind, "no_data");
  }
  const h = harness("get_domain_info", { routes: { WhoisPanel: () => ({ status: 200, body: { nameservers: [null, "ns1.host.example.net"] } }) } });
  assert.deepEqual((await h.run({ domain: "host.example.net", sections: ["whois"] })).whois.nameservers, ["ns1.host.example.net"]);
});

test("get_domain_info: WHOIS is opt-in, allowlisted, and a rate limit is reported per section", async () => {
  const h = harness("get_domain_info");
  const withWhois = await h.run({ domain: "host.example.net", sections: ["whois"] });
  assert.deepEqual(chartsCalled(h), ["WhoisPanel"]);
  assert.deepEqual(withWhois.whois, {
    registered_domain: "host.example.net", registrar: "Example Registrar, Inc.", created_utc: "2001-01-02T00:00:00.000Z", updated_utc: "2025-03-04T00:00:00.000Z", expires_utc: "2030-01-02T00:00:00.000Z",
    nameservers: ["ns1.host.example.net", "ns2.host.example.net"], status: ["clienttransferprohibited"], dnssec: false
  });
  const limited = harness("get_domain_info", { routes: { WhoisPanel: () => ({ status: 429, text: '{"error":"rate limited"}', headers: { "retry-after": "3500" } }) } });
  const partial = await limited.run({ domain: "host.example.net", sections: ["pq", "whois", "details"] });
  assert.equal(partial.status, "ok");
  assert.equal(partial.whois, null);
  assert.deepEqual(partial.unavailable, [{ section: "whois", kind: "rate_limited", message: "Radar rate-limited this request (HTTP 429).", retry_after_seconds: 3500 }]);
  assert.ok(partial.pq_support && partial.details);
  assert.deepEqual(partial.requested_sections, ["details", "pq", "whois"]);
  const only = await limited.run({ domain: "host.example.net", sections: ["whois"] });
  assert.equal(only.status, "error");
  assert.equal(only.error_kind, "rate_limited");
  assert.equal(only.retry_after_seconds, 3500);
});

test("get_domain_info: empty answers are no_data, not a fabricated success", async () => {
  const empty = {
    DomainDetailsPanel: () => ({ status: 200, body: { categories: null, asn: null, ranking: { dataset: null }, dnssec: false } }),
    DnsRecordsTable: () => ({ status: 200, body: { records: [] } }),
    DomainPqSupport: () => ({ status: 200, body: { pq: null, kexName: null, error: "api-error" } }),
    WhoisPanel: () => ({ status: 200, body: { nameservers: [] } })
  };
  const h = harness("get_domain_info", { routes: empty });
  const all = await h.run({ domain: "host.example.net", sections: ["details", "dns", "pq", "whois"] });
  assert.equal(all.status, "no_data");
  assert.deepEqual(all.unavailable.map(u => [u.section, u.kind]), [["details", "no_data"], ["dns", "no_data"], ["pq", "no_data"], ["whois", "no_data"]]);
  assert.match(all.unavailable[2].message, /could not test/);
  const some = await harness("get_domain_info", { routes: { ...empty, DomainDetailsPanel: () => ({ status: 200, body: details() }) } }).run({ domain: "host.example.net" });
  assert.equal(some.status, "ok");
  assert.deepEqual(some.unavailable.map(u => u.section), ["dns", "pq"]);
  assert.equal(some.dns_records, null);
  const uncategorized = await harness("get_domain_info", { routes: { DomainDetailsPanel: () => ({ status: 200, body: details({ categories: [] }) }) } }).run({ domain: "host.example.net", sections: ["details"] });
  assert.deepEqual(uncategorized.details.categories, []);
});

test("get_domain_info: site failures are explicit errors, and the worst one wins when nothing succeeded", async () => {
  const both = await harness("get_domain_info", { routes: { DomainDetailsPanel: () => ({ status: 500, text: "Error fetching data" }), DnsRecordsTable: () => ({ status: 429, text: "{}" }), DomainPqSupport: () => ({ status: 200, body: { pq: null, error: "api-error" } }) } }).run({ domain: "host.example.net" });
  assert.equal(both.error_kind, "rate_limited");
  const serverError = await harness("get_domain_info", { routes: { DomainDetailsPanel: () => ({ status: 500, text: "Error fetching data" }) } }).run({ domain: "host.example.net", sections: ["details"] });
  assert.equal(serverError.error_kind, "site_error");
  for (const [route, body, section] of [["DomainDetailsPanel", { categories: "x" }, "details"], ["DnsRecordsTable", { rows: [] }, "dns"], ["DomainPqSupport", { supported: true }, "pq"], ["WhoisPanel", [1], "whois"]]) {
    const result = await harness("get_domain_info", { routes: { [route]: () => ({ status: 200, body }) } }).run({ domain: "host.example.net", sections: [section] });
    assert.equal(result.error_kind, "site_changed", route);
  }
  const notJson = await harness("get_domain_info", { routes: { DnsRecordsTable: () => ({ status: 200, text: "<html>" }) } }).run({ domain: "host.example.net", sections: ["dns"] });
  assert.equal(notJson.error_kind, "site_error");
  const challenge = await harness("get_domain_info", { routes: { DnsRecordsTable: () => ({ status: 403, text: "Just a moment...", headers: { "cf-mitigated": "challenge" } }) } });
  assert.equal((await challenge.run({ domain: "host.example.net" })).error_kind, "challenge");
  assert.deepEqual(chartsCalled(challenge), ["DomainDetailsPanel", "TopDomainsTable", "DnsRecordsTable"], "stops at the first challenge");
  const thrown = await harness("get_domain_info", { routes: { DomainPqSupport: () => { throw new Error("network down"); } } }).run({ domain: "host.example.net" });
  assert.equal(thrown.error_kind, "site_error");
});

test("get_domain_info: requests are one GET per section against Radar's chart routes and nothing else", async () => {
  const h = harness("get_domain_info");
  await h.run({ domain: "xn--bcher-kva.example.com", sections: ["details", "dns", "pq", "whois"] });
  assert.deepEqual(h.calls.fetches.map(f => f.path), [
    "/charts/DomainDetailsPanel/fetch?domain=xn--bcher-kva.example.com", "/charts/TopDomainsTable/fetch?",
    "/charts/DnsRecordsTable/fetch?domain=xn--bcher-kva.example.com", "/charts/DomainPqSupport/fetch?domain=xn--bcher-kva.example.com", "/charts/WhoisPanel/fetch?domain=xn--bcher-kva.example.com"
  ]);
});

for (const name of NAMES) {
  test(`${name}: cancellation stops requests and errors do not echo credentials`, async () => {
    const input = name === "get_domain_info" ? { domain: "host.example.net" } : {};
    const controller = new AbortController();
    controller.abort();
    const before = harness(name);
    assert.equal((await before.run(input, { signal: controller.signal })).error_kind, "canceled");
    assert.equal(before.calls.fetches.length, 0);
    const during = new AbortController();
    const route = name === "get_domain_info" ? "DomainDetailsPanel" : "OutagesMap";
    const mid = harness(name, { routes: { [route]: () => { during.abort(); return { status: 200, body: name === "get_domain_info" ? details() : outageBody() }; } } });
    assert.equal((await mid.run(input, { signal: during.signal })).error_kind, "canceled");
    assert.equal(mid.calls.fetches.length, 1);
    assert.equal(mid.calls.fetches[0].init.signal, during.signal);
    const thrown = harness(name, { routes: { [route]: () => { throw new Error("https://example.net/?token=secret-fixture"); } } });
    assert.equal((await thrown.run(input)).error_kind, "site_error");
    assert.equal(JSON.stringify(await thrown.run(input)).includes("secret-fixture"), false);
  });
}

test("list_internet_outages: default window and unknown location state fail closed", async () => {
  for (const state of [{ location: { type: "continent", slug: "europe" }, dateRange: "7d" }, { location: { type: "global" }, dateRange: "28d" }]) {
    const result = await harness("list_internet_outages", { routes: { OutagesMap: () => ({ status: 200, body: outageBody({ state }) }) } }).run({});
    assert.equal(result.error_kind, "site_changed");
  }
  const h = harness("list_internet_outages", { routes: { OutagesMap: () => ({ status: 200, body: outageBody({ state: { location: { type: "asn", asn: "4294967295" }, dateRange: "7d" } }) }) } });
  assert.equal((await h.run({ location: "AS4294967295" })).status, "ok");
});

test("list_internet_outages: nested lists and text are bounded; credential-bearing links are omitted", async () => {
  const huge = "x".repeat(10000);
  const rows = Array.from({ length: 10 }, () => ({ code: "XA", name: huge }));
  const body = outageBody({ outages: [outage("1", "2026-09-01T00:00:00Z", { locationsDetails: rows, asnsDetails: rows.map(x => ({ asn: 64500, name: x.name })), originsDetails: rows.map(x => ({ origin: "example", name: x.name })), tags: rows.map(x => x.name), linkedUrl: "https://user:pass@example.net/?token=secret-fixture" })] });
  const result = await harness("list_internet_outages", { routes: { OutagesMap: () => ({ status: 200, body }) } }).run({});
  assert.equal(result.outages[0].locations.length, 5);
  assert.equal(result.outages[0].locations[0].name.length, 96);
  assert.equal(result.outages[0].linked_url, null);
  assert.ok(result.warnings.some(w => w.includes("five items")));
  for (const linkedUrl of ["https://example.net/?token=secret-fixture", "https://example.net/#secret-fixture", "https://example.net/" + huge]) {
    const r = await harness("list_internet_outages", { routes: { OutagesMap: () => ({ status: 200, body: outageBody({ outages: [outage("1", "2026-09-01", { linkedUrl })] }) }) } }).run({});
    assert.equal(r.outages[0].linked_url, null);
  }
});

test("get_domain_info: auxiliary text is bounded, invalid rankings ignored, PQ errors not echoed", async () => {
  const many = Array.from({ length: 100 }, () => "x".repeat(10000));
  const h = harness("get_domain_info", { routes: {
    DomainDetailsPanel: () => ({ status: 200, body: details({ categories: many.map(x => ({ label: [x] })) }) }),
    TopDomainsTable: () => ({ status: 200, body: { domains: [{ domain: "host.example.net", rank: 101 }] } }),
    WhoisPanel: () => ({ status: 200, body: { ...whois, nameservers: many, status: many } }),
    DomainPqSupport: () => ({ status: 200, body: { pq: null, error: "secret-fixture" } })
  } });
  const result = await h.run({ domain: "host.example.net", sections: ["details", "whois", "pq"] });
  assert.equal(result.details.categories.length, 20);
  assert.equal(result.details.categories[0].length, 253);
  assert.equal(result.details.top_100_rank, null);
  assert.equal(result.whois.nameservers.length, 20);
  assert.equal(JSON.stringify(result).includes("secret-fixture"), false);
});

test("get_domain_info: serialized output cap accounts for JSON escaping", async () => {
  const records = Array.from({ length: 200 }, () => ({ type: "TXT", name: "host.example.net", data: "\u0000".repeat(512) }));
  const h = harness("get_domain_info", { routes: { DnsRecordsTable: () => ({ status: 200, body: { records } }) } });
  const result = await h.run({ domain: "host.example.net", sections: ["dns"], dns_record_limit: 200 });
  assert.equal(result.error_kind, "site_changed");
  assert.ok(new TextEncoder().encode(JSON.stringify(result)).length < 200000);
});
