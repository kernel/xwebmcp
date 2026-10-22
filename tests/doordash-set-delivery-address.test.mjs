import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

// Fixture tests for doordash.com/set_delivery_address. The page (location, document, fetch) is stubbed;
// nothing here contacts the live site and every address, id and cookie is fabricated.
const source = readFileSync(new URL("../domains/doordash.com/set_delivery_address.js", import.meta.url), "utf8");
const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
const plain = value => JSON.parse(JSON.stringify(value));
const HOME = "https://www.doordash.com";
const AUTOCOMPLETE = "/unified-gateway/geo-intelligence/v2/address/autocomplete?input_address=";
const CREATE = "/unified-gateway/geo-intelligence/v2/address/get-or-create";
const MUTATION = "/graphql/addConsumerAddressV2?operation=addConsumerAddressV2";
const BUCKETING = "/graphql/consumerBucketing?operation=consumerBucketing";

function conforms(schema, value) {
  if (schema.oneOf && schema.oneOf.filter(s => conforms(s, value)).length !== 1) return false;
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type && ![schema.type].flat().some(type => {
    if (type === "null") return value === null;
    if (type === "integer") return Number.isInteger(value);
    if (type === "array") return Array.isArray(value);
    if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    return typeof value === type;
  })) return false;
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.items && !value.every(item => conforms(schema.items, item))) return false;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
    const props = schema.properties || {};
    if (Object.entries(props).some(([key, s]) => key in value && !conforms(s, value[key]))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !(key in props))) return false;
  }
  return true;
}

// --- fabricated site data ------------------------------------------------------------------------

const prediction = (n, extra = {}) => ({
  lat: 40.1 + n / 1000, lng: -73.1, formatted_address: `${n} Fabricated Plaza, Testville, NY 10001, USA`, formatted_address_short: `${n} Fabricated Plaza`,
  source_place_id: `fabricated-source-place-${n}`, postal_code: "10001", administrative_area_level1: "NY", locality: "Testville", street_address: `${n} Fabricated Plaza`, ...extra
});
const place = (n, extra = {}) => ({
  id: String(900 + n), lat: 40.1 + n / 1000, lng: -73.1, formatted_address: `${n} Fabricated Plaza, Testville, NY 10001, USA`, street_address: `${n} Fabricated Plaza`,
  locality: "Testville", administrative_area_level1: "NY", postal_code: "10001", formatted_address_short: `${n} Fabricated Plaza`,
  formatted_address_segmented: [`${n} Fabricated Plaza`, "Testville, NY 10001, USA"], source_place_id: `P000FAKE${n}`, ...extra
});
const saved = (n, extra = {}) => ({
  data: { addConsumerAddressV2: { defaultAddress: { id: String(900 + n), street: `${n} Fabricated Plaza`, city: "Testville", state: "NY", zipCode: "10001", printableAddress: `${n} Fabricated Plaza, Testville, NY 10001, USA`, submarket: "Testville" }, isGuest: true, ...extra } }
});

function harness(options = {}) {
  const calls = [];
  const replies = {
    [BUCKETING]: () => ({ status: 200, json: { data: { consumer: { isGuest: true } } } }),
    [AUTOCOMPLETE]: () => ({ status: 200, json: { predictions: [prediction(1), prediction(2), prediction(3)] } }),
    [CREATE]: init => ({ status: 200, json: { address: place(Number(/\d+$/.exec(JSON.parse(init.body).address_identifier.source_place_id)[0])) } }),
    [MUTATION]: init => ({ status: 200, json: saved(Number(JSON.parse(init.body).variables.addressId) - 900) }),
    ...options.replies
  };
  const stubFetch = async (url, init) => {
    calls.push({ url, init: { ...init, body: init.body ? JSON.parse(init.body) : undefined } });
    if (options.fetchError) throw options.fetchError;
    const key = Object.keys(replies).find(k => url.startsWith(k));
    assert.ok(key, "unexpected request " + url);
    const reply = replies[key](init);
    const body = reply.body ?? JSON.stringify(reply.json);
    return { status: reply.status, ok: reply.status >= 200 && reply.status < 300, text: async () => body };
  };
  const context = {
    location: { origin: options.origin ?? HOME, pathname: "/" },
    document: { cookie: options.cookie ?? "a=1; csrf_token=fabricated-csrf" },
    fetch: stubFetch, AbortSignal, JSON, Object, Array, Number, String, Boolean, Math, Promise, Error, RegExp, isFinite, encodeURIComponent
  };
  const [definition] = runInNewContext(`(${source})`, context);
  return {
    definition, calls,
    run: async input => {
      const result = plain(await definition.execute(input));
      assert.ok(conforms(definition.tool.outputSchema, result), JSON.stringify(result).slice(0, 300));
      return result;
    }
  };
}

// --- contract ------------------------------------------------------------------------------------

test("single page definition, narrowed to www, not read-only, and agrees with the registry", () => {
  const { definition } = harness();
  assert.equal(definition.kind, "page");
  assert.equal(definition.tool.name, "set_delivery_address");
  assert.deepEqual(plain(definition.match.url_patterns), ["https://www.doordash.com/*"]);
  assert.equal(definition.tool.annotations.readOnlyHint, false);
  const entry = registry.tools.find(t => t.domain === "doordash.com" && t.tool === "set_delivery_address");
  assert.equal(entry.kind, "page");
  assert.deepEqual(entry.url_patterns, ["https://www.doordash.com/*"]);
});

test("checks the visit is signed out, sets the first suggestion with the picker's three requests and reports DoorDash's confirmed address", async () => {
  const h = harness();
  const result = await h.run({ address: "  1 Fabricated   Plaza, Testville " });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.address, { printable: "1 Fabricated Plaza, Testville, NY 10001, USA", street: "1 Fabricated Plaza", city: "Testville", state: "NY", zip_code: "10001", submarket: "Testville" });
  assert.equal(result.suggestions.length, 3);
  assert.match(result.next_step, /list the tools again/);
  assert.deepEqual(h.calls.map(c => c.url), [BUCKETING, AUTOCOMPLETE + "1%20Fabricated%20Plaza%2C%20Testville", CREATE, MUTATION]);
  assert.equal(h.calls[0].init.body.query, "query consumerBucketing { consumer { isGuest } }");
  assert.equal(h.calls[1].init.method, undefined, "the lookup is a GET");
  assert.deepEqual(h.calls[2].init.body, { address_identifier: { _type: "source_place_id_request", source_place_id: "fabricated-source-place-1" } });
  const mutation = h.calls[3].init;
  assert.equal(mutation.headers["x-csrftoken"], "fabricated-csrf");
  assert.equal(mutation.body.operationName, "addConsumerAddressV2");
  assert.deepEqual(mutation.body.variables, { googlePlaceId: "P000FAKE1", printableAddress: "Testville, NY 10001, USA", lat: 40.101, lng: -73.1, city: "Testville", state: "NY", zipCode: "10001", shortname: "1 Fabricated Plaza", addressId: "901" });
  assert.match(mutation.body.query, /^mutation addConsumerAddressV2\(/);
});

test("chooses the numbered suggestion, and returns the suggestions when that number is out of range", async () => {
  const second = harness();
  assert.equal((await second.run({ address: "Fabricated Plaza", suggestion: 2 })).address.street, "2 Fabricated Plaza");
  const beyond = harness();
  const result = await beyond.run({ address: "Fabricated Plaza", suggestion: 4 });
  assert.equal(result.error_kind, "address_not_found");
  assert.equal(result.suggestions.length, 3);
  assert.equal(beyond.calls.length, 2, "nothing is created or set");
});

test("refuses bad input, other origins and signed-in visits before any request", async () => {
  for (const input of [null, {}, { address: "ab" }, { address: "x".repeat(201) }, { address: "1 Plaza", suggestion: 0 }, { address: "1 Plaza", suggestion: 1.5 }, { address: "1 Plaza", extra: 1 }]) {
    const h = harness();
    assert.equal((await h.run(input)).error_kind, "invalid_input", JSON.stringify(input));
    assert.equal(h.calls.length, 0);
  }
  const elsewhere = harness({ origin: "https://merchant-portal.doordash.com" });
  assert.equal((await elsewhere.run({ address: "1 Plaza" })).error_kind, "wrong_page");
  const signedIn = harness({ cookie: "dd_cx_logged_in=true; csrf_token=x" });
  const refused = await signedIn.run({ address: "1 Plaza" });
  assert.equal(refused.error_kind, "signed_in");
  assert.match(refused.error_message, /save_address/);
  assert.equal(elsewhere.calls.length + signedIn.calls.length, 0);
});

test("an address with no suggestion is address_not_found and changes nothing", async () => {
  const h = harness({ replies: { [AUTOCOMPLETE]: () => ({ status: 200, json: { predictions: [] } }) } });
  assert.equal((await h.run({ address: "Nowhere Fabricated" })).error_kind, "address_not_found");
  assert.equal(h.calls.length, 2);
});

test("site problems are reported, and an unconfirmed mutation says to check the page", async () => {
  const limited = harness({ replies: { [AUTOCOMPLETE]: () => ({ status: 429, json: {} }) } });
  assert.equal((await limited.run({ address: "1 Plaza" })).error_kind, "rate_limited");
  const drifted = harness({ replies: { [AUTOCOMPLETE]: () => ({ status: 200, json: { results: [] } }) } });
  assert.equal((await drifted.run({ address: "1 Plaza" })).error_kind, "site_changed");
  const unresolved = harness({ replies: { [CREATE]: () => ({ status: 200, json: { address: place(1, { postal_code: "" }) } }) } });
  assert.equal((await unresolved.run({ address: "1 Plaza" })).error_kind, "site_changed");
  assert.equal(unresolved.calls.length, 3, "the mutation is not sent for an incomplete address");
  const rejected = harness({ replies: { [MUTATION]: () => ({ status: 200, json: { errors: [{ message: "nope" }], data: null } }) } });
  const failed = await rejected.run({ address: "1 Plaza" });
  assert.equal(failed.error_kind, "site_error");
  assert.match(failed.error_message, /check the header/);
  const thrown = harness({ fetchError: new Error("offline") });
  assert.equal((await thrown.run({ address: "1 Plaza" })).error_kind, "site_error");
  const account = harness({ replies: { [MUTATION]: () => ({ status: 200, json: saved(1, { isGuest: false }) }) } });
  assert.equal((await account.run({ address: "1 Plaza" })).error_kind, "signed_in");
});

test("a signed-in visit without the cookie is refused before any address request", async () => {
  const account = harness({ replies: { [BUCKETING]: () => ({ status: 200, json: { data: { consumer: { isGuest: false } } } }) } });
  const refused = await account.run({ address: "1 Plaza" });
  assert.equal(refused.error_kind, "signed_in");
  assert.match(refused.error_message, /save_address/);
  assert.deepEqual(account.calls.map(c => c.url), [BUCKETING]);
  for (const reply of [{ status: 200, json: { data: { consumer: null } } }, { status: 200, json: { errors: [{ message: "x" }] } }, { status: 500, json: {} }]) {
    const unclear = harness({ replies: { [BUCKETING]: () => reply } });
    assert.equal((await unclear.run({ address: "1 Plaza" })).error_kind, "site_changed", JSON.stringify(reply));
    assert.equal(unclear.calls.length, 1);
  }
  const limited = harness({ replies: { [BUCKETING]: () => ({ status: 429, json: {} }) } });
  assert.equal((await limited.run({ address: "1 Plaza" })).error_kind, "rate_limited");
});

test("an answer naming a different address than the chosen suggestion is not success", async () => {
  for (const changed of [{ zipCode: "10002" }, { city: "Elsewhere" }, { zipCode: null }]) {
    const h = harness({ replies: { [MUTATION]: () => { const reply = saved(1); Object.assign(reply.data.addConsumerAddressV2.defaultAddress, changed); return { status: 200, json: reply }; } } });
    const result = await h.run({ address: "1 Plaza" });
    assert.equal(result.error_kind, "address_mismatch", JSON.stringify(changed));
    assert.match(result.error_message, /check the header/);
    assert.equal(result.suggestions.length, 3);
  }
  const caseOnly = harness({ replies: { [MUTATION]: () => { const reply = saved(1); reply.data.addConsumerAddressV2.defaultAddress.city = "TESTVILLE "; return { status: 200, json: reply }; } } });
  assert.equal((await caseOnly.run({ address: "1 Plaza" })).status, "ok");
});
