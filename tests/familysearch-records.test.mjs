import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

// Harness for the familysearch.org record tools. Every page and API interaction is stubbed and nothing here
// contacts the live site. People, records, collections, places and the session id below are fabricated.
const NAMES = ["search_records", "get_record", "list_collections"];
const sources = Object.fromEntries(NAMES.map(name => [name, readFileSync(new URL(`../domains/familysearch.org/${name}.js`, import.meta.url), "utf8")]));
const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
const plain = value => JSON.parse(JSON.stringify(value));
const FAKE_SESSION = "fabricated-session-id-000";
const OPERATOR = "fabricated-operator-note";

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
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
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
  }
  if (typeof value === "number") {
    if (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) return false;
  }
  return true;
}

// --- fabricated site data ---------------------------------------------------------------------------

const fact = (type, { date, place, normalized, value } = {}) => ({
  type: `http://gedcomx.org/${type}`,
  ...(date ? { date: { original: date } } : {}),
  ...(place ? { place: { original: place, ...(normalized ? { normalized: [{ value: normalized }] } : {}) } } : {}),
  ...(value ? { value } : {})
});
const field = (type, text, kind = "Interpreted") => ({ type: `http://familysearch.org/types/fields/${type}`, values: [{ labelId: type.toUpperCase(), text, type: `http://gedcomx.org/${kind}` }] });
const person = (id, persona, name, gender, facts = [], fields = []) => ({
  id, principal: true, display: { name, gender }, facts, fields,
  identifiers: { "http://gedcomx.org/Persistent": [`https://www.familysearch.org/ark:/61903/1:1:${persona}`] }
});
const rel = (type, a, b) => ({ type: `http://gedcomx.org/${type}`, person1: { resource: `#${a}` }, person2: { resource: `#${b}` } });
const recordSource = (title = "Household of Ada Example, \"Exampleland, Census, 1901\"") => ({
  id: "src_r_1", resourceType: "http://gedcomx.org/Record", about: "https://www.familysearch.org/ark:/61903/1:2:AAAA-BBBB", titles: [{ value: title }],
  citations: [{ value: "\"Exampleland, Census, 1901\", <i>FamilySearch</i> (https://www.familysearch.org/ark:/61903/1:1:AAAA-CCCC : Mon Jan 1 00:00:00 UTC 2024), Entry for Ada Example, 31 March 1901." }],
  coverage: [{ recordType: "http://gedcomx.org/Census", spatial: { original: "Exampletown, Exampleshire, Exampleland" }, temporal: { original: "31 March 1901" } }]
});
const collectionSource = (id = "9000001", title = "Exampleland, Census, 1901") => ({
  id: `sd_c_${id}`, resourceType: "http://gedcomx.org/Collection", about: `https://www.familysearch.org/service/cds/recapi/collections/${id}`, titles: [{ value: title }]
});
const FAMILY = () => [
  person("p_1", "AAAA-CCCC", "Ada Example", "Female", [fact("Birth", { date: "1860", place: "Exampletown", normalized: "Exampletown, Exampleshire, Exampleland" }), fact("Census", { date: "31 March 1901", place: "Exampletown, Exampleshire, Exampleland" }), fact("Census", { date: "31 March 1901", place: "Exampletown, Exampleshire, Exampleland" }), fact("Occupation", { value: "Weaver" }), fact("MaritalStatus", { value: "Married" })],
    [field("Age", "41 years"), field("RelationshipToHead", "Wife", "Original"), field("OccupationIndustry", "Textiles", "Original"), field("SortKey", "0000000000123_00001"), field("EnumeratorName", "Fabricated Enumerator", "Original")]),
  person("p_2", "AAAA-CCCD", "Ben Example", "Male", [fact("Census", { date: "31 March 1901", place: "Exampletown" })], [field("Age", "45 years")]),
  person("p_3", "AAAA-CCCF", "Cy Example", "Male", [fact("Census", { date: "31 March 1901", place: "Exampletown" })], [])
];
const FAMILY_RELS = () => [rel("Couple", "p_1", "p_2"), rel("ParentChild", "p_1", "p_3"), rel("ParentChild", "p_2", "p_3")];
const searchEntry = (id = "AAAA-CCCC", extra = {}) => ({
  id, score: 5.1, confidence: 4,
  content: { gedcomx: { persons: FAMILY(), relationships: FAMILY_RELS(), sourceDescriptions: [recordSource(), collectionSource(), { id: "sd_da1", resourceType: "http://gedcomx.org/DigitalArtifact", about: "https://www.familysearch.org/ark:/61903/3:1:AAAA-BBBB-CCCC" }], links: { self: { href: `https://www.familysearch.org/ark:/61903/1:1:${id}` } } } },
  ...extra
});
const collectionFacet = () => [{
  displayName: "Collection", params: "c.collectionId=on&m.facetNestCollectionInCategory=on", count: 30,
  facets: [
    { displayName: "Censuses & Lists", params: "c.collectionType=on&f.collectionType=0", count: 30, facets: [{ displayName: "Exampleland, Census, 1901", params: "c.collectionId=on&f.collectionId=9000001", count: 25 }, { displayName: "Exampleland, Census, 1911", params: "c.collectionId=on&f.collectionId=9000002", count: 5 }] }
  ]
}, { displayName: "Sex", params: "c.sex=on", count: 30, facets: [{ displayName: "Female", params: "c.sex=on&f.sex=female", count: 20 }] }];
const searchBody = (entries = [searchEntry()], results = 941) => ({ results, index: 0, entries, facets: collectionFacet() });

const recordBody = (extra = {}) => ({
  id: "r_1", description: "#sd_p_1", persons: FAMILY(), relationships: FAMILY_RELS(),
  sourceDescriptions: [recordSource(), collectionSource(), { id: "sd_da1", resourceType: "http://gedcomx.org/DigitalArtifact", about: "https://www.familysearch.org/ark:/61903/3:1:AAAA-BBBB-CCCC" }],
  fields: [{ type: "http://familysearch.org/types/fields/RecordGroup", values: [{ text: OPERATOR }] }, { type: "http://familysearch.org/types/fields/ExtData", values: [{ text: "{\"FS_COLLECTION_ID\":\"9000001\"}" }] }],
  ...extra
});
const listEntry = (id, title, o = {}) => ({ collectionId: id, title, lastUpdatedMillis: Date.UTC(2026, 0, 15), startYear: 1901, endYear: 1901, placeIds: [100], recordType: "CENSUS", region: "UNITED_KINGDOM_IRELAND", recordCount: 1000, imageCount: 50, waypointUrl: null, ...o });
const LIST = () => [
  listEntry("9000001", "Exampleland, Census, 1901", { recordCount: 3000000 }),
  listEntry("9000002", "Exampleland, Census, 1911", { startYear: 1911, endYear: 1911, recordCount: 4000000, imageCount: 0 }),
  listEntry("9000003", "Exampleland, Civil Registration, 1850–1950", { startYear: 1850, endYear: 1950, recordType: "VITAL", recordCount: 0, imageCount: 900, lastUpdatedMillis: Date.UTC(2026, 5, 1) }),
  listEntry("9000004", "Otherstate, Vital Records, 1880-1930", { startYear: 1880, endYear: 1930, placeIds: [200], region: "UNITED_STATES", recordType: "VITAL", recordCount: 500 }),
  listEntry("9000005", "United States, Census, 1950", { startYear: 1950, endYear: 1950, placeIds: [1], region: "UNITED_STATES", recordCount: 150000000 }),
  listEntry("9000006", "Exampleland Census Index", { startYear: 1901, endYear: 1921, recordType: "CENSUS", recordCount: 10 })
];
const listBody = (list = LIST()) => ({
  collectionList: list, totalHits: 0,
  facets: [{
    token: "region", displayName: "Place", values: [
      { token: "region:UNITED_KINGDOM_IRELAND", displayName: "United Kingdom and Ireland", facets: [{ token: "countryId", displayName: "Country", values: [{ token: "placeId:100", displayName: "Exampleland", "token-orig": "100" }] }] },
      { token: "region:UNITED_STATES", displayName: "United States of America", facets: [{ token: "countryId", displayName: "Country", values: [{ token: "placeId:200", displayName: "Otherstate", "token-orig": "200" }, { token: "placeId:1", displayName: "United States", "token-orig": "1" }] }] }
    ]
  }]
});

// --- harness ------------------------------------------------------------------------------------------

function harness(name, o = {}) {
  const calls = [];
  const timers = [];
  const route = o.route ?? (() => ({ status: 200, body: {} }));
  let sleeps = 0;
  const document = {
    get cookie() {
      const cookie = o.cookie ?? `fs_experiments=abc; fssessionid=${FAKE_SESSION}; fsgeo=203.0.113.9`;
      return o.cookieAfter !== undefined && sleeps < o.cookieAfter ? cookie.replace(/fssessionid=[^;]+;?\s*/, "") : cookie;
    },
    querySelector: selector => {
      if (o.header === "in" && selector.includes("/auth/logout")) return {};
      if (o.header === "out" && selector.includes("/identity/signup")) return {};
      return null;
    }
  };
  const origin = o.origin ?? "https://www.familysearch.org";
  const context = {
    URL, URLSearchParams, AbortController, document, location: { origin, host: new URL(origin).host },
    setTimeout: (fn, ms) => {
      if (ms === 500) { sleeps++; queueMicrotask(fn); return 0; }
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: id => { timers[id - 1] = null; },
    fetch: async (url, init) => {
      calls.push({ url, init });
      assert.equal(init.credentials, "include");
      assert.ok(!String(url).startsWith("http"), "requests must be same-origin relative URLs");
      if (o.fetchError) {
        if (o.fetchError === "timeout") {
          const aborted = new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
          timers[0]();
          return aborted;
        }
        throw new Error("network down");
      }
      const r = route(String(url), init);
      const raw = r.html ? "<html>challenge</html>" : typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {});
      return { status: r.status, headers: { get: header => (header.toLowerCase() === "content-type" ? (r.html ? "text/html" : "application/json") : null) }, text: async () => raw };
    }
  };
  const [definition] = runInNewContext(`(${sources[name]})`, context);
  return {
    definition, calls, sleeps: () => sleeps,
    run: async input => {
      const result = plain(await definition.execute(input));
      assert.ok(conforms(definition.tool.outputSchema, result), `${name} output violates its schema: ${JSON.stringify(result)}`);
      const text = JSON.stringify(result);
      assert.ok(!text.includes(FAKE_SESSION), "the session id must not leave the page");
      assert.ok(!text.includes(OPERATOR) && !text.includes("FS_COLLECTION_ID") && !text.includes("SortKey") && !text.includes("Fabricated Enumerator"), "internal record fields must not be returned");
      return result;
    }
  };
}
const query = call => new URL(call.url, "https://www.familysearch.org").searchParams;

// --- structure ----------------------------------------------------------------------------------------

for (const name of NAMES) {
  test(`${name}: single-expression page tool with typed schemas and a registry entry`, () => {
    assert.equal(sources[name].trimEnd().endsWith(";"), false);
    assert.equal(/\b(Buffer|require|process)\b/.test(sources[name]), false, "tool source must not depend on Node globals");
    assert.equal(/\b(js|gotoUrl|pageInfo|waitForLoad|accessibilitySnapshot|click|pressKey|cdp)\(/.test(sources[name]), false, "page tools cannot use runtime helpers");
    assert.equal(/location\.(assign|replace|href\s*=)|\.submit\(|window\.open/.test(sources[name]), false, "tools must never navigate the tab");
    assert.equal(/method\s*:\s*["'](POST|PUT|PATCH|DELETE)/i.test(sources[name]), false, "tools only issue GET requests");
    const { definition } = harness(name);
    assert.equal(definition.tool.name, name);
    assert.equal(definition.kind, "page");
    assert.deepEqual(plain(definition.match.url_patterns), ["https://www.familysearch.org/*"]);
    assert.equal(definition.tool.inputSchema.type, "object");
    assert.equal(definition.tool.inputSchema.additionalProperties, false);
    assert.equal(definition.tool.outputSchema.type, "object");
    assert.equal(definition.tool.annotations.readOnlyHint, true);
    assert.equal(definition.tool.annotations.destructiveHint, false);
    const entry = registry.tools.find(t => t.domain === "familysearch.org" && t.tool === name);
    assert.ok(entry, "registry entry missing");
    assert.equal(entry.file, `domains/familysearch.org/${name}.js`);
    assert.equal(entry.kind, "page");
    assert.deepEqual(entry.url_patterns, plain(definition.match.url_patterns));
  });
}

test("registry lists every familysearch.org tool exactly once", () => {
  assert.deepEqual(registry.tools.filter(t => t.domain === "familysearch.org").map(t => t.tool).sort(), [...NAMES].sort());
});

// --- input validation happens before any request ------------------------------------------------------

const invalidInputs = {
  search_records: [undefined, null, [], "smith", {}, { surname: "" }, { surname: "   " }, { surname: 5 }, { surname: "x".repeat(101) }, { surname: "smith", extra: 1 },
    { birth_year_from: 1880 }, { exact: true }, { surname: "smith", birth_year_from: 0 }, { surname: "smith", birth_year_from: 2101 }, { surname: "smith", birth_year_from: 1880.5 },
    { surname: "smith", birth_year_from: "1880" }, { surname: "smith", birth_year_from: 1890, birth_year_to: 1880 }, { surname: "smith", exact: "yes" },
    { surname: "smith", collection_id: "abc" }, { surname: "smith", collection_id: 4464515 }, { surname: "smith", collection_id: "12345678901" }, { surname: "smith", limit: 0 }, { surname: "smith", limit: 51 },
    { surname: "smith", limit: "5" }, { surname: "smith", offset: -1 }, { surname: "smith", offset: 4999 }, { surname: "smith", limit: 50, offset: 4950 }, { surname: "smith", limit: 2, offset: 4998 }],
  get_record: [undefined, null, [], {}, { record: "" }, { record: 5 }, { record: "   " }, { record: "abc" }, { record: "AAAA-BB" }, { record: "aaaa-bbbb" }, { record: "1:3:AAAA-BBBB" }, { record: "3:1:AAAA-BBBB-CCCC" },
    { record: "AAAA-CCCC" }, { record: "KWCJ-RN4" }, { record: "4:1:AAAA-CCCC" }, { record: "https://www.familysearch.org/ark:/61903/4:1:AAAA-CCCC" }, { record: "1:1:aaaa-cccc" }, { record: "https://www.familysearch.org/ark:/61903/1:1:AAAA-CCCC?" + "x".repeat(300) },
    { record: "https://ancestors.familysearch.org/ark:/61903/1:1:AAAA-BBBB" }, { record: "https://familysearch.org.example.net/ark:/61903/1:1:AAAA-BBBB" }, { record: "http://www.familysearch.org/ark:/61903/1:1:AAAA-BBBB" },
    { record: "https://www.familysearch.org/en/tree/person/details/AAAA-BBB" }, { record: "AAAA-BBBB", extra: 1 }, { record: "x".repeat(301) }],
  list_collections: [undefined, null, [], "ireland", { extra: 1 }, { query: "" }, { query: 5 }, { query: "x".repeat(101) }, { place: " " }, { record_type: "census" }, { record_type: "BIRTHS" }, { year_from: 0 }, { year_to: 2101 }, { year_from: 1950, year_to: 1900 },
    { year_from: "1900" }, { min_records: 0 }, { min_records: 1.5 }, { has_images: "yes" }, { sort_by: "size" }, { limit: 0 }, { limit: 51 }, { offset: -1 }, { offset: 3501 }]
};
for (const [name, inputs] of Object.entries(invalidInputs)) {
  for (const input of inputs) {
    test(`${name}: rejects ${JSON.stringify(input)?.slice(0, 80)} before any request`, async () => {
      const h = harness(name, { route: () => ({ status: 200, body: {} }) });
      const result = await h.run(input);
      assert.equal(result.status, "error");
      assert.equal(result.error_kind, "invalid_input");
      assert.deepEqual(h.calls, []);
    });
  }
}

const validInputs = { search_records: { surname: "Example" }, get_record: { record: "1:1:AAAA-CCCC" }, list_collections: {} };
for (const name of NAMES) {
  test(`${name}: a registration on another familysearch.org host returns wrong_page without any request`, async () => {
    for (const origin of ["https://ident.familysearch.org", "https://ancestors.familysearch.org", "https://familysearch.org"]) {
      const h = harness(name, { origin, route: () => ({ status: 200, body: {} }) });
      const result = await h.run(validInputs[name]);
      assert.equal(result.status, "error");
      assert.equal(result.error_kind, "wrong_page");
      assert.match(result.error_message, new RegExp(new URL(origin).host.replace(/\./g, "\\.")));
      assert.deepEqual(h.calls, []);
    }
  });
}

// --- search_records -----------------------------------------------------------------------------------

test("search_records: sends the site's own query flags and terms and maps hits to the allowlisted fields", async () => {
  const h = harness("search_records", { header: "out", route: () => ({ status: 200, body: searchBody([searchEntry("AAAA-CCCC"), searchEntry("AAAA-CCCD")], 941) }) });
  const result = await h.run({ given_name: "  Ada  ", surname: "Example", birth_place: "Exampleshire", birth_year_from: 1855, birth_year_to: 1865, keyword: "weaver", limit: 2 });
  assert.equal(h.calls.length, 1);
  const call = h.calls[0];
  assert.match(call.url, /^\/service\/search\/hr\/v2\/personas\?/);
  assert.equal(call.init.headers.Authorization, undefined, "search sends no bearer token");
  assert.deepEqual(Object.fromEntries(query(call)), {
    count: "2", offset: "0", "m.defaultFacets": "on", "m.facetNestCollectionInCategory": "on", "m.queryRequireDefault": "on",
    "q.givenName": "Ada", "q.surname": "Example", "q.birthLikePlace": "Exampleshire", "q.birthLikeDate.from": "1855", "q.birthLikeDate.to": "1865", "q.miscKeyword": "weaver"
  });
  assert.equal(result.status, "ok");
  assert.equal(result.signed_in, false);
  assert.equal(result.total_results, 941);
  assert.equal(result.returned, 2);
  assert.equal(result.has_more, true);
  const [first, second] = result.hits;
  assert.equal(first.persona_id, "AAAA-CCCC");
  assert.equal(first.record_url, "https://www.familysearch.org/ark:/61903/1:1:AAAA-CCCC");
  assert.equal(second.persona_id, "AAAA-CCCD");
  assert.equal(first.name, "Ada Example");
  assert.equal(first.sex, "Female");
  assert.equal(first.record_type, "Census");
  assert.equal(first.record_title, "Household of Ada Example, \"Exampleland, Census, 1901\"");
  assert.deepEqual(first.collection, { collection_id: "9000001", title: "Exampleland, Census, 1901" });
  assert.deepEqual(first.birth, { date: "1860", place: "Exampletown, Exampleshire, Exampleland" });
  assert.deepEqual(first.events, [{ type: "Census", date: "31 March 1901", place: "Exampletown, Exampleshire, Exampleland" }]);
  assert.deepEqual(first.attributes, [{ type: "Occupation", value: "Weaver" }, { type: "MaritalStatus", value: "Married" }]);
  assert.deepEqual(first.relatives, [
    { relationship: "spouse", name: "Ben Example", sex: "Male", persona_id: "AAAA-CCCD" },
    { relationship: "child", name: "Cy Example", sex: "Male", persona_id: "AAAA-CCCF" }
  ]);
  assert.deepEqual(second.relatives, [{ relationship: "spouse", name: "Ada Example", sex: "Female", persona_id: "AAAA-CCCC" }, { relationship: "child", name: "Cy Example", sex: "Male", persona_id: "AAAA-CCCF" }]);
  assert.deepEqual(result.collections, [
    { collection_id: "9000001", title: "Exampleland, Census, 1901", hit_count: 25 },
    { collection_id: "9000002", title: "Exampleland, Census, 1911", hit_count: 5 }
  ]);
});

test("search_records: exact and collection filters use the site's parameter names", async () => {
  const h = harness("search_records", { header: "in", route: () => ({ status: 200, body: searchBody([searchEntry()], 1) }) });
  const result = await h.run({ given_name: "Ada", surname: "Example", birth_place: "Exampleshire", exact: true, collection_id: "9000001", offset: 40, limit: 10 });
  const params = query(h.calls[0]);
  for (const key of ["q.givenName.exact", "q.surname.exact", "q.birthLikePlace.exact", "c.collectionId"]) assert.equal(params.get(key), "on", key);
  assert.equal(params.get("f.collectionId"), "9000001");
  assert.equal(params.get("offset"), "40");
  assert.equal(params.get("count"), "10");
  assert.equal(params.has("q.miscKeyword"), false);
  assert.equal(result.signed_in, true);
  assert.equal(result.has_more, false);
});

test("search_records: encodes special characters instead of splicing them into the query", async () => {
  const h = harness("search_records", { route: () => ({ status: 200, body: searchBody() }) });
  await h.run({ surname: "O'Neil & Sons=x", given_name: "Zoë #1" });
  assert.equal(query(h.calls[0]).get("q.surname"), "O'Neil & Sons=x");
  assert.equal(query(h.calls[0]).get("q.givenName"), "Zoë #1");
  assert.equal([...query(h.calls[0]).keys()].filter(k => k.startsWith("q.")).length, 2);
});

test("search_records: the subject is the entry whose persistent id matches, whichever order the people come in", async () => {
  const entry = searchEntry("AAAA-CCCD");
  const h = harness("search_records", { route: () => ({ status: 200, body: searchBody([entry], 1) }) });
  const result = await h.run({ surname: "Example" });
  assert.equal(result.hits[0].name, "Ben Example");
  assert.deepEqual(result.hits[0].relatives.map(r => r.relationship), ["spouse", "child"]);
  assert.equal(result.hits[0].birth, null);
});

test("search_records: has_more respects the site's result depth", async () => {
  const total = 100000;
  const entries = [searchEntry("AAAA-CCCC"), searchEntry("AAAA-CCCD")];
  for (const [offset, expected] of [[4996, true], [4997, false]]) {
    const h = harness("search_records", { route: () => ({ status: 200, body: searchBody(entries, total) }) });
    const result = await h.run({ surname: "Example", limit: 2, offset });
    assert.equal(result.has_more, offset + 2 <= 4998, `offset ${offset}`);
    assert.equal(result.has_more, expected);
  }
  const h = harness("search_records", { route: () => ({ status: 200, body: searchBody([searchEntry()], 1) }) });
  assert.equal((await h.run({ surname: "Example" })).has_more, false);
});

test("search_records: reports no_results, and an offset past the last hit, without inventing hits", async () => {
  const empty = harness("search_records", { header: "out", route: () => ({ status: 200, body: { results: 0, index: 0, entries: [], facets: [] } }) });
  assert.deepEqual(await empty.run({ surname: "Nobody" }), { status: "no_results", signed_in: false, total_results: 0, offset: 0 });
  const past = harness("search_records", { route: () => ({ status: 200, body: { results: 30, index: 40, facets: [] } }) });
  assert.deepEqual(await past.run({ surname: "Example", offset: 40 }), { status: "no_results", signed_in: null, total_results: 30, offset: 40 });
});

test("search_records: signed_in comes from the page header only", async () => {
  for (const [header, expected] of [["in", true], ["out", false], [undefined, null]]) {
    const h = harness("search_records", { header, route: () => ({ status: 200, body: searchBody() }) });
    assert.equal((await h.run({ surname: "Example" })).signed_in, expected);
    assert.equal(h.calls.length, 1, "no extra request is made to learn the sign-in state");
  }
});

test("search_records: maps site refusals to explicit errors", async () => {
  const cases = [
    [{ status: 401 }, "out", "login_required", /signed-in browser/],
    [{ status: 401 }, "in", "login_required", /expired/],
    [{ status: 403, body: { message: "no" } }, "out", "forbidden", /refused/],
    [{ status: 403, html: true }, "out", "challenge", /bot protection/],
    [{ status: 200, html: true }, "out", "challenge", /instead of search data/],
    [{ status: 429 }, "out", "rate_limited", /rate limiting/],
    [{ status: 500, body: {} }, "out", "site_error", /HTTP 500/],
    [{ status: 400, body: { errors: ["Unsupported Term=zzz"] } }, "out", "site_error", /Unsupported Term=zzz/],
    [{ status: 200, body: { unexpected: true } }, "out", "site_changed", /expected shape/],
    [{ status: 200, body: { results: "many", entries: [] } }, "out", "site_changed", /expected shape/],
    [{ status: 200, body: { results: 3, entries: [{ id: "AAAA-CCCC", content: {} }, { id: 7 }] } }, "out", "site_changed", /persona structure/]
  ];
  for (const [response, header, kind, message] of cases) {
    const h = harness("search_records", { header, route: () => response });
    const result = await h.run({ surname: "Example", collection_id: "9000001" });
    assert.equal(result.status, "error");
    assert.equal(result.error_kind, kind, JSON.stringify(response));
    assert.match(result.error_message, message);
  }
  for (const fetchError of [true, "timeout"]) {
    const result = await harness("search_records", { fetchError }).run({ surname: "Example" });
    assert.equal(result.error_kind, "site_error");
    assert.match(result.error_message, fetchError === "timeout" ? /40 seconds/ : /failed before a response/);
  }
});

test("search_records: sanitizes untrusted record text and bounds every list", async () => {
  const persons = FAMILY();
  persons[0].display.name = "Ada\u0000 \u0007Example\n" + "x".repeat(400);
  persons[0].facts = Array.from({ length: 30 }, (_, i) => fact("Residence", { date: `${1800 + i}`, place: `Place ${i}` })).concat(Array.from({ length: 30 }, (_, i) => fact(`Attr${i}`, { value: `v${i}` })));
  const entry = searchEntry();
  entry.content.gedcomx.persons = persons.concat(Array.from({ length: 30 }, (_, i) => person(`p_x${i}`, `ZZZZ-${String(1000 + i)}`, `Extra ${i}`, "Male")));
  entry.content.gedcomx.relationships = Array.from({ length: 30 }, (_, i) => rel("ParentChild", "p_1", `p_x${i}`));
  const h = harness("search_records", { route: () => ({ status: 200, body: searchBody([entry], 1) }) });
  const [hit] = (await h.run({ surname: "Example" })).hits;
  assert.ok(hit.name.length <= 200 && !/[\u0000-\u001f]/.test(hit.name));
  assert.equal(hit.events.length, 8);
  assert.equal(hit.attributes.length, 8);
  assert.equal(hit.relatives.length, 10);
});

// --- get_record ---------------------------------------------------------------------------------------

const recordRoute = (body = recordBody()) => (url, init) => {
  if (/\/ark:\/61903\/1:[12]:AAAA-CCCC\?/.test(url) || /\/ark:\/61903\/1:2:AAAA-BBBB\?/.test(url)) return { status: 200, body };
  return { status: 404, body: {} };
};

test("get_record: reads the persona and returns the household, links, collection and citation", async () => {
  const h = harness("get_record", { header: "in", route: recordRoute() });
  const result = await h.run({ record: "https://www.familysearch.org/ark:/61903/1:1:AAAA-CCCC?lang=en&cc=123#x" });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, "/ark:/61903/1:1:AAAA-CCCC?useSLS=true&useRolesOverride=false");
  assert.equal(h.calls[0].init.headers.Authorization, `Bearer ${FAKE_SESSION}`);
  assert.equal(h.calls[0].init.headers.Accept, "application/json");
  assert.equal(result.status, "ok");
  assert.equal(result.record_url, "https://www.familysearch.org/ark:/61903/1:1:AAAA-CCCC");
  assert.equal(result.ark_kind, "persona");
  assert.equal(result.record_type, "Census");
  assert.equal(result.record_title, "Household of Ada Example, \"Exampleland, Census, 1901\"");
  assert.deepEqual(result.collection, { collection_id: "9000001", title: "Exampleland, Census, 1901", url: "https://www.familysearch.org/en/search/collection/9000001" });
  assert.deepEqual(result.event, { date: "31 March 1901", place: "Exampletown, Exampleshire, Exampleland" });
  assert.equal(result.subject_index, 0);
  assert.equal(result.persons_truncated, false);
  assert.deepEqual(result.persons.map(p => p.persona_id), ["AAAA-CCCC", "AAAA-CCCD", "AAAA-CCCF"]);
  assert.deepEqual(result.persons[0], {
    persona_id: "AAAA-CCCC", record_url: "https://www.familysearch.org/ark:/61903/1:1:AAAA-CCCC", name: "Ada Example", sex: "Female",
    birth: { date: "1860", place: "Exampletown, Exampleshire, Exampleland" },
    events: [{ type: "Census", date: "31 March 1901", place: "Exampletown, Exampleshire, Exampleland" }],
    attributes: [{ type: "Occupation", value: "Weaver" }, { type: "MaritalStatus", value: "Married" }, { type: "Age", value: "41 years" }, { type: "RelationshipToHead", value: "Wife" }, { type: "OccupationIndustry", value: "Textiles" }]
  });
  assert.deepEqual(result.relationships, [{ type: "couple", person_1: 0, person_2: 1 }, { type: "parent_child", person_1: 0, person_2: 2 }, { type: "parent_child", person_1: 1, person_2: 2 }]);
  assert.equal(result.citation, "\"Exampleland, Census, 1901\", FamilySearch (https://www.familysearch.org/ark:/61903/1:1:AAAA-CCCC : Mon Jan 1 00:00:00 UTC 2024), Entry for Ada Example, 31 March 1901.");
});

test("get_record: accepts ark paths, household arks and URLs, and canonicalizes the URL", async () => {
  for (const [record, url, kind, subject] of [
    ["1:1:AAAA-CCCC", "/ark:/61903/1:1:AAAA-CCCC?", "persona", 0],
    ["ark:/61903/1:1:AAAA-CCCC", "/ark:/61903/1:1:AAAA-CCCC?", "persona", 0],
    ["/ark:/61903/1:2:AAAA-BBBB", "/ark:/61903/1:2:AAAA-BBBB?", "record", null],
    ["https://familysearch.org/ark:/61903/1:2:AAAA-BBBB", "/ark:/61903/1:2:AAAA-BBBB?", "record", null],
    ["  https://www.familysearch.org/ark:/61903/1:1:AAAA-CCCC  ", "/ark:/61903/1:1:AAAA-CCCC?", "persona", 0]
  ]) {
    const h = harness("get_record", { route: recordRoute() });
    const result = await h.run({ record });
    assert.ok(h.calls[0].url.startsWith(url), record);
    assert.equal(result.ark_kind, kind);
    assert.equal(result.subject_index, subject);
    assert.equal(result.record_url, "https://www.familysearch.org/ark:/61903" + url.slice("/ark:/61903".length, -1));
  }
});

test("get_record: sends the session bearer only when the page has a session cookie, and never returns it", async () => {
  const anonymous = harness("get_record", { cookie: "fsgeo=203.0.113.9", route: recordRoute() });
  const result = await anonymous.run({ record: "1:1:AAAA-CCCC" });
  assert.equal(result.status, "ok");
  assert.equal(anonymous.calls[0].init.headers.Authorization, undefined);
  const withSession = harness("get_record", { cookie: `a=1;fssessionid=${FAKE_SESSION};b=2`, route: recordRoute() });
  await withSession.run({ record: "1:1:AAAA-CCCC" });
  assert.equal(withSession.calls[0].init.headers.Authorization, `Bearer ${FAKE_SESSION}`);
});

test("get_record: strips markup, control characters and unallowlisted fields from untrusted record data", async () => {
  const body = recordBody();
  body.persons[0].display.name = "Ada <b>Example</b>\u0000\u0007";
  body.sourceDescriptions[0].citations[0].value = "<script>alert(1)</script>Cited <i>work</i>, entry";
  const h = harness("get_record", { route: recordRoute(body) });
  const result = await h.run({ record: "1:1:AAAA-CCCC" });
  assert.equal(result.citation, "alert(1)Cited work, entry");
  assert.ok(!/[\u0000-\u001f]/.test(result.persons[0].name));
  const text = JSON.stringify(result);
  for (const banned of [OPERATOR, "ExtData", "SortKey", "EnumeratorName", "RecordGroup"]) assert.ok(!text.includes(banned), banned);
});

test("get_record: caps a very large household at 40 people and keeps links between those people only", async () => {
  const body = recordBody();
  body.persons = Array.from({ length: 45 }, (_, i) => person(`p_${i}`, `BBBB-${String(1000 + i)}`, `Person ${i}`, "Male"));
  body.persons[0] = { ...FAMILY()[0], id: "p_0" };
  body.relationships = [rel("Couple", "p_0", "p_1"), rel("ParentChild", "p_0", "p_44"), rel("Friend", "p_0", "p_2")];
  const h = harness("get_record", { route: (url) => (/AAAA-CCCC/.test(url) ? { status: 200, body } : { status: 404 }) });
  const result = await h.run({ record: "1:1:AAAA-CCCC" });
  assert.equal(result.persons.length, 40);
  assert.equal(result.persons_truncated, true);
  assert.deepEqual(result.relationships, [{ type: "couple", person_1: 0, person_2: 1 }]);
});

test("get_record: a persona ark that is not among the listed people has no subject", async () => {
  const body = recordBody();
  body.persons.forEach(p => { p.identifiers = {}; });
  const h = harness("get_record", { route: recordRoute(body) });
  const result = await h.run({ record: "1:1:AAAA-CCCC" });
  assert.equal(result.subject_index, null);
  assert.equal(result.persons[0].persona_id, null);
  assert.equal(result.persons[0].record_url, null);
});

test("get_record: a persistent id with trailing text is not read as a persona id", async () => {
  const body = recordBody();
  body.persons[0].identifiers["http://gedcomx.org/Persistent"] = ["https://www.familysearch.org/ark:/61903/1:1:AAAA-CCCCZZ", "https://www.familysearch.org/ark:/61903/1:1:AAAA-CCCC/extra"];
  const result = await harness("get_record", { route: recordRoute(body) }).run({ record: "1:1:AAAA-CCCC" });
  assert.equal(result.persons[0].persona_id, null);
  assert.equal(result.subject_index, null);
});

test("get_record: maps site refusals to explicit errors", async () => {
  const cases = [
    [{ status: 401 }, "out", "login_required", /requires a signed-in browser/],
    [{ status: 401 }, "in", "login_required", /did not accept this browser's session/],
    [{ status: 403, body: { message: "no" } }, "in", "forbidden", /needs a signed-in account/],
    [{ status: 403, html: true }, "out", "challenge", /bot protection/],
    [{ status: 200, html: true }, "out", "challenge", /instead of record data/],
    [{ status: 404, body: {} }, "out", "not_found", /no record 1:1:AAAA-CCCC/],
    [{ status: 429 }, "out", "rate_limited", /rate limiting/],
    [{ status: 503, body: {} }, "out", "site_error", /HTTP 503/],
    [{ status: 200, body: { persons: [] } }, "out", "site_changed", /expected shape/],
    [{ status: 200, body: { unexpected: 1 } }, "out", "site_changed", /expected shape/]
  ];
  for (const [response, header, kind, message] of cases) {
    const h = harness("get_record", { header, route: () => response });
    const result = await h.run({ record: "1:1:AAAA-CCCC" });
    assert.equal(result.status, "error");
    assert.equal(result.error_kind, kind, JSON.stringify(response));
    assert.match(result.error_message, message);
  }
  for (const fetchError of [true, "timeout"]) {
    const result = await harness("get_record", { fetchError }).run({ record: "1:1:AAAA-CCCC" });
    assert.equal(result.error_kind, "site_error");
  }
});

// --- list_collections ---------------------------------------------------------------------------------

const listRun = async (input, list = listBody()) => {
  const h = harness("list_collections", { route: () => ({ status: 200, body: list }) });
  return { h, result: await h.run(input) };
};
const ids = result => result.collections.map(c => c.collection_id);

test("list_collections: reads the site's own collection list once and maps the allowlisted fields", async () => {
  const { h, result } = await listRun({});
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, "/search/orchestration/collectionListData");
  assert.equal(h.calls[0].init.headers.Authorization, undefined);
  assert.equal(result.status, "ok");
  assert.equal(result.total_matches, 6);
  assert.deepEqual(ids(result), ["9000005", "9000002", "9000001", "9000004", "9000006", "9000003"]);
  const census = result.collections.find(c => c.collection_id === "9000001");
  assert.deepEqual(census, {
    collection_id: "9000001", title: "Exampleland, Census, 1901", url: "https://www.familysearch.org/en/search/collection/9000001", record_type: "CENSUS", region: "UNITED_KINGDOM_IRELAND",
    start_year: 1901, end_year: 1901, places: ["Exampleland"], record_count: 3000000, image_count: 50, last_updated: "2026-01-15"
  });
  assert.ok(!JSON.stringify(result).includes("waypoint"));
});

test("list_collections: title words must all match, and relevance puts titles that start with the query first", async () => {
  assert.deepEqual(ids((await listRun({ query: "census exampleland" })).result), ["9000002", "9000001", "9000006"]);
  assert.deepEqual(ids((await listRun({ query: "exampleland census" })).result), ["9000002", "9000001", "9000006"]);
  const withPrefix = listBody([...LIST(), listEntry("9000007", "Census: Exampleland Supplement", { recordCount: 20 })]);
  assert.deepEqual(ids((await listRun({ query: "census exampleland" }, withPrefix)).result), ["9000007", "9000002", "9000001", "9000006"]);
  assert.deepEqual(ids((await listRun({ query: "CIVIL registration" })).result), ["9000003"]);
  assert.deepEqual(await (await listRun({ query: "zzz" })).result, { status: "no_results", total_matches: 0, offset: 0 });
});

test("list_collections: place matches a country, a state or a world region by its filter name", async () => {
  assert.deepEqual(ids((await listRun({ place: "exampleland" })).result).sort(), ["9000001", "9000002", "9000003", "9000006"]);
  assert.deepEqual(ids((await listRun({ place: "OTHERSTATE" })).result), ["9000004"]);
  assert.deepEqual(ids((await listRun({ place: "United States" })).result), ["9000005"]);
  assert.deepEqual(ids((await listRun({ place: "United States of America" })).result), ["9000005", "9000004"]);
  assert.deepEqual(ids((await listRun({ place: "United Kingdom and Ireland" })).result).sort(), ["9000001", "9000002", "9000003", "9000006"]);
});

test("list_collections: an unknown place is an input error with similar names, not an empty list", async () => {
  const { result } = await listRun({ place: "Example" });
  assert.equal(result.status, "error");
  assert.equal(result.error_kind, "invalid_input");
  assert.match(result.error_message, /similar names: Exampleland/);
  const none = (await listRun({ place: "Atlantis" })).result;
  assert.equal(none.error_kind, "invalid_input");
  assert.match(none.error_message, /use a country, US state or world-region name/);
});

test("list_collections: type, year overlap, size and image filters", async () => {
  assert.deepEqual(ids((await listRun({ record_type: "VITAL" })).result).sort(), ["9000003", "9000004"]);
  assert.deepEqual(ids((await listRun({ year_from: 1940 })).result).sort(), ["9000003", "9000005"]);
  assert.deepEqual(ids((await listRun({ year_to: 1850 })).result), ["9000003"]);
  assert.deepEqual(ids((await listRun({ year_from: 1905, year_to: 1911 })).result).sort(), ["9000002", "9000003", "9000004", "9000006"]);
  assert.deepEqual(ids((await listRun({ min_records: 3500000 })).result), ["9000005", "9000002"]);
  assert.deepEqual(ids((await listRun({ has_images: false })).result), ["9000002"]);
  assert.deepEqual(ids((await listRun({ has_images: true, record_type: "CENSUS", place: "exampleland" })).result).sort(), ["9000001", "9000006"]);
  const imageOnly = (await listRun({ record_type: "VITAL", place: "exampleland" })).result.collections[0];
  assert.equal(imageOnly.record_count, 0);
  assert.equal(imageOnly.image_count, 900);
});

test("list_collections: sorting and paging", async () => {
  const byTitle = LIST().sort((a, b) => a.title.localeCompare(b.title)).map(c => c.collectionId);
  assert.deepEqual(ids((await listRun({ sort_by: "title" })).result), byTitle);
  assert.deepEqual(ids((await listRun({ sort_by: "last_updated", limit: 1 })).result), ["9000003"]);
  const page = (await listRun({ limit: 2, offset: 2 })).result;
  assert.deepEqual([page.total_matches, page.offset, page.returned, page.has_more, ids(page)], [6, 2, 2, true, ["9000001", "9000004"]]);
  const last = (await listRun({ limit: 5, offset: 4 })).result;
  assert.deepEqual([last.returned, last.has_more], [2, false]);
  assert.deepEqual((await listRun({ offset: 6 })).result, { status: "no_results", total_matches: 6, offset: 6 });
});

test("list_collections: keeps non-ASCII titles and reports absent dates and counts as safe defaults", async () => {
  const { result } = await listRun({ query: "1850–1950" });
  assert.equal(result.collections[0].title, "Exampleland, Civil Registration, 1850–1950");
  const odd = listBody([listEntry("9000009", "Odd", { startYear: null, endYear: null, recordCount: null, imageCount: undefined, lastUpdatedMillis: undefined, placeIds: [999] })]);
  const item = (await listRun({}, odd)).result.collections[0];
  assert.deepEqual([item.start_year, item.end_year, item.record_count, item.image_count, item.last_updated, item.places], [null, null, 0, 0, null, []]);
});

test("list_collections: maps site refusals and shape changes to explicit errors", async () => {
  const cases = [
    [{ status: 401 }, "login_required", /signed-in browser/],
    [{ status: 403, body: {} }, "forbidden", /refused/],
    [{ status: 403, html: true }, "challenge", /bot protection/],
    [{ status: 200, html: true }, "challenge", /instead of the collection list/],
    [{ status: 429 }, "rate_limited", /rate limiting/],
    [{ status: 502, body: {} }, "site_error", /HTTP 502/],
    [{ status: 200, body: { collectionList: [] } }, "site_changed", /expected shape/],
    [{ status: 200, body: { collectionList: [{ collectionId: 5, title: "x" }] } }, "site_changed", /expected shape/],
    [{ status: 200, body: { nothing: true } }, "site_changed", /expected shape/]
  ];
  for (const [response, kind, message] of cases) {
    const h = harness("list_collections", { route: () => response });
    const result = await h.run({});
    assert.equal(result.status, "error");
    assert.equal(result.error_kind, kind, JSON.stringify(response));
    assert.match(result.error_message, message);
  }
  const noFacet = harness("list_collections", { route: () => ({ status: 200, body: { collectionList: LIST(), facets: [] } }) });
  assert.equal((await noFacet.run({ place: "Exampleland" })).error_kind, "site_changed");
  assert.equal((await noFacet.run({ query: "census" })).status, "ok");
  for (const fetchError of [true, "timeout"]) {
    assert.equal((await harness("list_collections", { fetchError }).run({})).error_kind, "site_error");
  }
});

// --- review fixes ---------------------------------------------------------------------------------------

test("search_records: waits for the site to set an anonymous session cookie before searching", async () => {
  const late = harness("search_records", { cookieAfter: 3, route: () => ({ status: 200, body: searchBody() }) });
  assert.equal((await late.run({ surname: "Example" })).status, "ok");
  assert.equal(late.sleeps(), 3);
  const ready = harness("search_records", { route: () => ({ status: 200, body: searchBody() }) });
  await ready.run({ surname: "Example" });
  assert.equal(ready.sleeps(), 0);
});

test("search_records: a page that never gets a session cookie is a site_error, not a sign-in request", async () => {
  const noCookie = { cookie: "fsgeo=203.0.113.9" };
  const refused = harness("search_records", { ...noCookie, header: "out", route: () => ({ status: 401 }) });
  const result = await refused.run({ surname: "Example" });
  assert.equal(result.error_kind, "site_error");
  assert.match(result.error_message, /no FamilySearch session cookie/);
  assert.doesNotMatch(result.error_message, /Sign in/);
  assert.equal(refused.sleeps(), 20);
  const answered = harness("search_records", { ...noCookie, route: () => ({ status: 200, body: searchBody() }) });
  assert.equal((await answered.run({ surname: "Example" })).status, "ok");
});

test("search_records: keeps the site's error text readable when errors are not strings", async () => {
  const h = harness("search_records", { route: () => ({ status: 400, body: { errors: [{ code: 1 }, "Bad Term=x"] } }) });
  assert.match((await h.run({ surname: "Example" })).error_message, /HTTP 400: Bad Term=x\./);
  const objects = harness("search_records", { route: () => ({ status: 400, body: { errors: [{ code: 1 }] } }) });
  const result = await objects.run({ surname: "Example" });
  assert.doesNotMatch(result.error_message, /object Object/);
  assert.match(result.error_message, /HTTP 400\./);
});

test("search_records: skips entries whose persona id is not in the site's uppercase format", async () => {
  const entry = searchEntry("AAAA-CCCC");
  entry.id = "aaaa-cccc";
  for (const person of entry.content.gedcomx.persons) person.identifiers["http://gedcomx.org/Persistent"] = person.identifiers["http://gedcomx.org/Persistent"].map(uri => uri.toLowerCase());
  const h = harness("search_records", { route: () => ({ status: 200, body: searchBody([entry], 1) }) });
  assert.equal((await h.run({ surname: "Example" })).error_kind, "site_changed");
});

test("search_records: lists at most 10 collections, largest first", async () => {
  const body = searchBody();
  body.facets = [{ displayName: "Collection", params: "c.collectionId=on&m.facetNestCollectionInCategory=on", count: 100, facets: [{ displayName: "Group", params: "c.collectionType=on&f.collectionType=0", facets: Array.from({ length: 12 }, (_, i) => ({ displayName: `Collection ${i}`, params: `c.collectionId=on&f.collectionId=${8000000 + i}`, count: i + 1 })) }] }];
  const result = await harness("search_records", { route: () => ({ status: 200, body }) }).run({ surname: "Example" });
  assert.deepEqual(result.collections.map(c => c.hit_count), [12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
});

test("every tool strips control, bidirectional and zero-width characters from site text", async () => {
  const dirty = "Ada\u0085 \u202eExa\u200bmple \ufeff";
  const entry = searchEntry();
  entry.content.gedcomx.persons[0].display.name = dirty;
  const search = await harness("search_records", { route: () => ({ status: 200, body: searchBody([entry], 1) }) }).run({ surname: "Example" });
  assert.equal(search.hits[0].name, "Ada Exa mple");
  const body = recordBody();
  body.persons[0].display.name = dirty;
  const record = await harness("get_record", { route: recordRoute(body) }).run({ record: "1:1:AAAA-CCCC" });
  assert.equal(record.persons[0].name, "Ada Exa mple");
  const list = await harness("list_collections", { route: () => ({ status: 200, body: listBody([listEntry("9000001", dirty)]) }) }).run({});
  assert.equal(list.collections[0].title, "Ada Exa mple");
  const blank = await harness("list_collections", { route: () => ({ status: 200, body: listBody([listEntry("9000001", "\u200b\u202e \u0085")]) }) }).run({});
  assert.equal(blank.collections[0].title, "(untitled)");
});

const crowd = (count, subjectAt) => Array.from({ length: count }, (_, i) => person(`p_${i}`, i === subjectAt ? "AAAA-CCCC" : `BBBB-${String(1000 + i)}`, `Person ${i}`, "Male"));

test("get_record: the requested person is always included and listed first when the record is truncated", async () => {
  const body = recordBody({ persons: crowd(60, 55), relationships: [rel("Couple", "p_55", "p_1"), rel("Couple", "p_0", "p_1")] });
  const result = await harness("get_record", { route: recordRoute(body) }).run({ record: "1:1:AAAA-CCCC" });
  assert.equal(result.persons.length, 40);
  assert.equal(result.persons_truncated, true);
  assert.equal(result.subject_index, 0);
  assert.equal(result.persons[0].persona_id, "AAAA-CCCC");
  assert.equal(result.persons[1].name, "Person 0");
  assert.deepEqual(result.relationships, [{ type: "couple", person_1: 0, person_2: 2 }, { type: "couple", person_1: 1, person_2: 2 }]);
});

test("get_record: the requested person stays in place at index 39 and moves to the front at index 40", async () => {
  for (const [at, expected] of [[39, 39], [40, 0]]) {
    const body = recordBody({ persons: crowd(60, at), relationships: [] });
    const result = await harness("get_record", { route: recordRoute(body) }).run({ record: "1:1:AAAA-CCCC" });
    assert.equal(result.subject_index, expected, `subject at ${at}`);
    assert.equal(result.persons[expected].persona_id, "AAAA-CCCC");
  }
});

test("get_record: persons_truncated turns on only above 40 people", async () => {
  for (const [count, truncated] of [[40, false], [41, true]]) {
    const body = recordBody({ persons: crowd(count, 0), relationships: [] });
    const result = await harness("get_record", { route: recordRoute(body) }).run({ record: "1:1:AAAA-CCCC" });
    assert.equal(result.persons.length, 40);
    assert.equal(result.persons_truncated, truncated, `${count} people`);
    assert.equal(result.subject_index, 0);
  }
});

test("get_record: bounds events, attributes and links per record", async () => {
  const body = recordBody({ persons: crowd(40, 0), relationships: [] });
  body.persons[0].facts = Array.from({ length: 20 }, (_, i) => fact("Residence", { date: `${1800 + i}`, place: `Place ${i}` })).concat(Array.from({ length: 20 }, (_, i) => fact(`Attr${i}`, { value: `v${i}` })));
  body.persons[0].fields = [field("Age", "40 years")];
  for (const [links, truncated] of [[80, false], [81, true]]) {
    body.relationships = Array.from({ length: links }, (_, i) => rel("ParentChild", "p_0", `p_${1 + (i % 39)}`));
    const result = await harness("get_record", { route: recordRoute(body) }).run({ record: "1:1:AAAA-CCCC" });
    assert.equal(result.persons[0].events.length, 12);
    assert.equal(result.persons[0].attributes.length, 12);
    assert.equal(result.relationships.length, 80);
    assert.equal(result.relationships_truncated, truncated, `${links} links`);
  }
});

test("get_record: only a cookie named exactly fssessionid becomes the bearer token", async () => {
  for (const cookie of ["notfssessionid=abc; x=1", "xfssessionid=abc", "fssessionid_old=abc", "a=1"]) {
    const h = harness("get_record", { cookie, route: recordRoute() });
    await h.run({ record: "1:1:AAAA-CCCC" });
    assert.equal(h.calls[0].init.headers.Authorization, undefined, cookie);
  }
});

test("get_record: removes entity-encoded and literal markup from the citation", async () => {
  const body = recordBody();
  body.sourceDescriptions[0].citations[0].value = "&lt;script&gt;alert(1)&lt;/script&gt;Cited &amp;amp; <i>x</i> &#39;q&#39; &quot;r&quot;";
  const result = await harness("get_record", { route: recordRoute(body) }).run({ record: "1:1:AAAA-CCCC" });
  assert.equal(result.citation, "alert(1)Cited &amp; x 'q' \"r\"");
});

test("list_collections: query words match whole words only, ignoring case, accents and punctuation", async () => {
  const list = listBody([
    listEntry("9000010", "Us Census Records"), listEntry("9000011", "Albania, Census, 1930"), listEntry("9000012", "Argentina, Córdoba, Censuses, 1869"),
    listEntry("9000013", "Exampleland, Civil Registration, 1850–1950"), listEntry("9000014", "Exampleland Marriages")
  ]);
  assert.deepEqual(ids((await listRun({ query: "us" }, list)).result), ["9000010"]);
  assert.deepEqual(ids((await listRun({ query: "us census" }, list)).result), ["9000010"]);
  assert.deepEqual((await listRun({ query: "cens" }, list)).result, { status: "no_results", total_matches: 0, offset: 0 });
  assert.deepEqual(ids((await listRun({ query: "CORDOBA censuses" }, list)).result), ["9000012"]);
  assert.deepEqual(ids((await listRun({ query: "civil-registration 1850 1950" }, list)).result), ["9000013"]);
  for (const query of ["!!!", " – ", "---"]) {
    const h = harness("list_collections", { route: () => ({ status: 200, body: list }) });
    const result = await h.run({ query });
    assert.equal(result.error_kind, "invalid_input");
    assert.deepEqual(h.calls, []);
  }
});

test("list_collections: filter boundaries are inclusive", async () => {
  const list = listBody([
    listEntry("9000021", "A", { startYear: 1900, endYear: 1910, recordCount: 100 }),
    listEntry("9000022", "B", { startYear: 1911, endYear: 1920, recordCount: 99 })
  ]);
  assert.deepEqual(ids((await listRun({ year_from: 1910 }, list)).result).sort(), ["9000021", "9000022"]);
  assert.deepEqual(ids((await listRun({ year_from: 1911 }, list)).result), ["9000022"]);
  assert.deepEqual(ids((await listRun({ year_to: 1911 }, list)).result).sort(), ["9000021", "9000022"]);
  assert.deepEqual(ids((await listRun({ year_to: 1910 }, list)).result), ["9000021"]);
  assert.deepEqual(ids((await listRun({ min_records: 100 }, list)).result), ["9000021"]);
  assert.deepEqual(ids((await listRun({ min_records: 99 }, list)).result).sort(), ["9000021", "9000022"]);
});

test("list_collections: lists at most 6 places per collection and survives implausible dates", async () => {
  const many = Array.from({ length: 8 }, (_, i) => 300 + i);
  const list = listBody([listEntry("9000031", "Wide", { placeIds: many, lastUpdatedMillis: 1e20 }), listEntry("9000032", "Old", { lastUpdatedMillis: -5 })]);
  list.facets[0].values[0].facets[0].values.push(...many.map(id => ({ token: `placeId:${id}`, displayName: `Place ${id}`, "token-orig": String(id) })));
  const result = (await listRun({ sort_by: "title" }, list)).result;
  assert.deepEqual(result.collections.map(c => c.places.length), [0 + 1, 6]);
  assert.deepEqual(result.collections.map(c => c.last_updated), [null, null]);
});

test("list_collections: collection ids that are not plain digits are a site_changed error", async () => {
  for (const collectionId of ["../../evil", "123456789012", "12a", ""]) {
    const h = harness("list_collections", { route: () => ({ status: 200, body: listBody([listEntry(collectionId, "Odd")]) }) });
    assert.equal((await h.run({})).error_kind, "site_changed", collectionId);
  }
});
