import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

// get_delivery_address and set_delivery_address are page tools: execute runs in the page,
// so each test evaluates the file in a fresh context that only has page globals (fetch,
// location) backed by a fake GraphQL endpoint. All data is fabricated.

const source = name => readFileSync(new URL(`../domains/instacart.com/${name}.js`, import.meta.url), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));

function conforms(schema, value) {
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type && ![schema.type].flat().some(type => {
    if (type === "null") return value === null;
    if (type === "integer") return Number.isInteger(value);
    if (type === "number") return typeof value === "number" && Number.isFinite(value);
    if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    if (type === "array") return Array.isArray(value);
    return typeof value === type;
  })) return false;
  if (schema.oneOf && schema.oneOf.filter(s => conforms(s, value)).length !== 1) return false;
  if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
  if (schema.properties && value !== null && typeof value === "object") {
    if (Object.entries(schema.properties).some(([key, s]) => key in value && !conforms(s, value[key]))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !(key in schema.properties))) return false;
  }
  if (Array.isArray(value) && schema.items && !value.every(v => conforms(schema.items, v))) return false;
  if (typeof value === "string") {
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) return false;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
    if (schema.format === "uri" && !URL.canParse(value)) return false;
  }
  if (typeof value === "number") {
    if (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) return false;
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) return false;
  }
  return true;
}

const saved = [
  { id: "900001", businessName: null, apartmentNumber: null, streetAddress: "100 Main Street", postalCode: "62701", viewSection: { lineOneString: "100 Main Street", lineTwoString: "Springfield, IL 62701" } },
  { id: "900002", businessName: "", apartmentNumber: "4B", streetAddress: "200 Oak Avenue", postalCode: "62704", viewSection: { lineOneString: "200 Oak Avenue", lineTwoString: "Springfield, IL 62704" } }
];
const zones = { "62701": "78", "62704": "79" };

function page(name, options = {}) {
  const state = { selected: options.selected === undefined ? "900001" : options.selected, requests: [], mutations: 0 };
  const respond = (op, variables) => {
    if (options.respond) { const custom = options.respond(op, variables, state); if (custom) return custom; }
    switch (op) {
      case "GetLastUserLocation": {
        if (options.noLocation) return { data: { lastUserLocation: null } };
        const current = saved.find(a => a.id === state.selected);
        return { data: { lastUserLocation: current ? { addressId: current.id, zoneId: zones[current.postalCode], postalCode: current.postalCode } : { addressId: null, zoneId: "78", postalCode: "62701" } } };
      }
      case "UserAddresses": return { data: { userAddresses: options.addresses ?? saved } };
      case "UpdateUserLocation": {
        state.mutations++;
        if (options.mutation === "silent") return { data: { updateUserLocation: null } };
        state.selected = variables.addressId;
        return { data: { updateUserLocation: { addressId: variables.addressId, zoneId: zones[variables.postalCode], postalCode: variables.postalCode } } };
      }
      default: return { errors: [{ message: "unknown op", extensions: { code: "PERSISTED_QUERY_NOT_SUPPORTED" } }], data: null };
    }
  };
  const url = new URL(options.url ?? "https://www.instacart.com/store/account");
  const context = {
    URL, JSON, Array, Object, String, Number, RegExp, Error, Promise,
    location: { origin: url.origin, hostname: url.hostname, protocol: url.protocol, href: url.href },
    fetch: async (input, init = {}) => {
      const target = typeof input === "string" ? new URL(input, url.origin) : input;
      assert.equal(init.headers["x-client-identifier"], "web");
      let op, variables;
      if (init.method === "POST") ({ operationName: op, variables } = JSON.parse(init.body));
      else { op = target.searchParams.get("operationName"); variables = JSON.parse(target.searchParams.get("variables")); }
      state.requests.push({ op, variables, method: init.method ?? "GET" });
      if (options.http?.[op]) return { status: options.http[op], text: async () => "" };
      if (options.throwOn === op) throw new Error("network down");
      return { status: 200, text: async () => JSON.stringify(respond(op, variables)) };
    }
  };
  const tool = runInNewContext(`(${source(name)})`, context)[0];
  return { tool, state, run: async input => {
    const result = plain(await tool.execute(input));
    assert.ok(conforms(tool.tool.outputSchema, result), `${name} output violates its schema: ${JSON.stringify(result)}`);
    return result;
  } };
}

for (const name of ["get_delivery_address", "set_delivery_address"]) {
  test(`${name}: single-expression page tool with domain patterns and typed schemas`, () => {
    const { tool } = page(name);
    assert.equal(tool.kind, "page");
    assert.equal(tool.tool.name, name);
    assert.deepEqual(plain(tool.match.url_patterns), ["https://instacart.com/*", "https://*.instacart.com/*"]);
    assert.equal(tool.tool.outputSchema.oneOf.length, 2);
    assert.equal(/;\s*$/.test(source(name)), false);
    assert.equal(/\b(?:Buffer|require|process|gotoUrl|js)\(/.test(source(name)), false);
  });

  test(`${name}: refuses to run off instacart.com`, async () => {
    const h = page(name, { url: "https://www.instacart.com.evil.example/store" });
    const result = await h.run(name === "get_delivery_address" ? {} : { address_id: "900002" });
    assert.equal(result.error_kind, "wrong_page");
    assert.deepEqual(h.state.requests, []);
  });
}

test("get_delivery_address: lists saved addresses and marks the selected one", async () => {
  const result = await page("get_delivery_address").run({});
  assert.equal(result.status, "ok");
  assert.equal(result.selected_address_id, "900001");
  assert.deepEqual(result.location, { postal_code: "62701", zone_id: "78" });
  assert.deepEqual(result.selected_address, { address_id: "900001", street_address: "100 Main Street", apartment: null, business_name: null, line_one: "100 Main Street", line_two: "Springfield, IL 62701", postal_code: "62701", is_selected: true });
  assert.deepEqual(result.addresses.map(a => [a.address_id, a.apartment, a.business_name, a.is_selected]), [["900001", null, null, true], ["900002", "4B", null, false]]);
});

test("get_delivery_address: a postal-code-only location has no selected address", async () => {
  const result = await page("get_delivery_address", { selected: null }).run({});
  assert.equal(result.selected_address_id, null);
  assert.equal(result.selected_address, null);
  assert.equal(result.addresses.every(a => !a.is_selected), true);
});

test("get_delivery_address: rejects input fields and reports site failures", async () => {
  assert.equal((await page("get_delivery_address").run({ address_id: "1" })).error_kind, "invalid_input");
  assert.equal((await page("get_delivery_address").run(null)).error_kind, "invalid_input");
  assert.equal((await page("get_delivery_address", { noLocation: true }).run({})).error_kind, "location_unavailable");
  assert.equal((await page("get_delivery_address", { http: { UserAddresses: 401 } }).run({})).error_kind, "not_logged_in");
  assert.equal((await page("get_delivery_address", { http: { GetLastUserLocation: 429 } }).run({})).error_kind, "throttled");
  assert.equal((await page("get_delivery_address", { respond: op => op === "UserAddresses" ? { errors: [{ extensions: { code: "PERSISTED_QUERY_NOT_FOUND" } }], data: null } : null }).run({})).error_kind, "site_changed");
  assert.equal((await page("get_delivery_address", { selected: null, addresses: [] }).run({})).error_kind, "not_logged_in");
});

test("set_delivery_address: switches with one mutation and returns the confirmed location", async () => {
  const h = page("set_delivery_address");
  const result = await h.run({ address_id: "900002" });
  assert.deepEqual(result, { status: "ok", changed: true, mutation_attempted: true, previous_address_id: "900001", selected_address_id: "900002", line_one: "200 Oak Avenue", line_two: "Springfield, IL 62704", location: { postal_code: "62704", zone_id: "79" } });
  assert.equal(h.state.mutations, 1);
  assert.deepEqual(h.state.requests.find(r => r.op === "UpdateUserLocation"), { op: "UpdateUserLocation", variables: { addressId: "900002", postalCode: "62704" }, method: "POST" });
});

test("set_delivery_address: the already selected address sends nothing", async () => {
  const h = page("set_delivery_address");
  const result = await h.run({ address_id: "900001" });
  assert.equal(result.changed, false);
  assert.equal(result.mutation_attempted, false);
  assert.equal(h.state.mutations, 0);
});

test("set_delivery_address: invalid input and unknown ids are rejected before any mutation", async () => {
  for (const input of [null, {}, { address_id: 900002 }, { address_id: "abc" }, { address_id: "900002", extra: 1 }]) {
    const h = page("set_delivery_address");
    const result = await h.run(input);
    assert.equal(result.error_kind, "invalid_input", JSON.stringify(input));
    assert.equal(result.mutation_attempted, false);
    assert.deepEqual(h.state.requests, []);
  }
  const h = page("set_delivery_address");
  const unknown = await h.run({ address_id: "123" });
  assert.equal(unknown.error_kind, "address_not_found");
  assert.equal(unknown.mutation_attempted, false);
  assert.equal(h.state.mutations, 0);
});

test("set_delivery_address: an unconfirmed or failed mutation is unknown and never retried", async () => {
  const silent = page("set_delivery_address", { mutation: "silent" });
  const a = await silent.run({ address_id: "900002" });
  assert.equal(a.error_kind, "unknown");
  assert.equal(a.mutation_attempted, true);
  assert.equal(silent.state.mutations, 1);
  const broken = page("set_delivery_address", { throwOn: "UpdateUserLocation" });
  const b = await broken.run({ address_id: "900002" });
  assert.equal(b.error_kind, "unknown");
  assert.equal(b.mutation_attempted, true);
  assert.match(b.error_message, /after the request was sent/);
  assert.equal(broken.state.requests.filter(r => r.op === "UpdateUserLocation").length, 1);
  const rejected = page("set_delivery_address", { http: { UpdateUserLocation: 401 } });
  const c = await rejected.run({ address_id: "900002" });
  assert.equal(c.error_kind, "not_logged_in");
  assert.equal(c.mutation_attempted, true);
});
