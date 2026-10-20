import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

// Harness for marriott.com get_room_rates: the tool runs from its source with a fake fetch that serves fabricated
// rate responses; nothing here contacts the live site. Hotels, rooms and prices are invented.
const source = readFileSync(new URL("../domains/marriott.com/get_room_rates.js", import.meta.url), "utf8");
const extension = runInNewContext(readFileSync(new URL("../extension/sandbox/schema.js", import.meta.url), "utf8") + ";xw.schema");
const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
const plain = value => JSON.parse(JSON.stringify(value));
const VALID = { property_id: "abcde", check_in: "2099-03-02", check_out: "2099-03-04", adults_per_room: 2 };

const cash = (amount, currency = "USD") => ({ amount, currency, decimalPoint: 2 });
const room = ({ name, description, rate, terms = "Pay at hotel.", category = "StandardRates", members = false, nightly, subtotal, fees, total }) => ({
  node: {
    __typename: "HotelRoom",
    availabilityAttributes: { productRateCategory: { typeCode: category, value: null } },
    basicInformation: { name, description, isMembersOnly: members },
    rates: { name: rate, description: terms, rateModes: { __typename: "HotelRoomRateModesCash", averageNightlyRatePerUnit: { amount: cash(nightly) } } },
    totalPricing: { rateModes: { grandTotal: { amount: cash(total) }, subtotalPerQuantity: { amount: cash(subtotal) }, totalMandatoryFeesPerQuantity: { amount: cash(fees) } } }
  }
});
const ROOMS = [
  room({ name: "Example King", description: "Guest room, 1 King", rate: "Member Flexible Rate", members: true, nightly: 20000, subtotal: 40000, fees: 5000, total: 51250 }),
  room({ name: "Example King", description: "Guest room, 1 King", rate: "Flexible Rate", nightly: 21050, subtotal: 42100, fees: 5000, total: 53600 }),
  room({ name: "Example Double", description: "Guest room, 2 Double", rate: "Prepay Non-refundable", category: "Prepay", nightly: 19000, subtotal: 38000, fees: 5000, total: 48900 })
];
const ok = edges => ({ body: { data: { commerce: { product: { searchProductsByProperty: { __typename: "ProductSearchByPropertyConnection", total: edges.length, edges } } } } } });

function harness(o = {}) {
  const calls = [];
  const context = {
    JSON, Math, Number, Object, Array, String, RegExp, Date, AbortSignal,
    window: { location: { origin: o.origin ?? "https://www.marriott.com" } },
    document: { title: o.title ?? "Marriott Bonvoy Hotels" },
    fetch: async (path, init = {}) => {
      calls.push({ path, headers: init.headers, body: JSON.parse(init.body) });
      if (o.throws) throw new TypeError("Failed to fetch");
      const r = o.respond ? o.respond() : ok(ROOMS);
      return { status: r.status ?? 200, text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)) };
    }
  };
  const [definition] = runInNewContext(`(${source})`, context);
  return {
    calls, definition,
    run: async input => {
      const result = plain(await definition.execute(input, {}));
      const checked = extension.compile(plain(definition.tool.outputSchema), "outputSchema")(result);
      assert.equal(checked.valid, true, checked.errorMessage);
      return result;
    }
  };
}

test("get_room_rates is a read-only page tool registered for www.marriott.com", () => {
  const entry = registry.tools.find(t => t.domain === "marriott.com" && t.tool === "get_room_rates");
  const [definition] = runInNewContext(`(${source})`, {});
  assert.equal(entry.kind, definition.kind);
  assert.deepEqual(entry.url_patterns, [...definition.match.url_patterns]);
  assert.equal(definition.tool.annotations.readOnlyHint, true);
});

test("get_room_rates sends the site's rate request and returns every rate in the site's order", async () => {
  const h = harness();
  const result = await h.run(VALID);
  assert.equal(h.calls.length, 1);
  const call = h.calls[0];
  assert.equal(call.path, "/mi/query/PhoenixBookDTTSearchProductsByProperty");
  assert.equal(call.headers["graphql-operation-signature"], "3f1389385982f058de948b5b51f2ee3db7aa5420920d0761083f139090bc1f9e");
  assert.deepEqual([call.body.variables.search.propertyId, call.body.variables.search.options.startDate, call.body.variables.search.options.endDate, call.body.variables.search.options.numberInParty, call.body.variables.search.options.quantity], ["ABCDE", "2099-03-02", "2099-03-04", 2, 1]);
  assert.deepEqual([result.status, result.property_id, result.nights, result.total, result.next_offset], ["ok", "ABCDE", 2, 3, null]);
  assert.deepEqual(result.rates.map(r => [r.room_name, r.rate_name, r.members_only, r.average_nightly_rate]), [
    ["Example King", "Member Flexible Rate", true, 200], ["Example King", "Flexible Rate", false, 210.5], ["Example Double", "Prepay Non-refundable", false, 190]
  ], "site order is kept, not re-ranked by price");
  assert.deepEqual(result.rates[2], { room_name: "Example Double", room_description: "Guest room, 2 Double", rate_name: "Prepay Non-refundable", rate_terms: "Pay at hotel.", rate_category: "Prepay", members_only: false, currency: "USD", average_nightly_rate: 190, stay_subtotal: 380, mandatory_fees: 50, stay_total: 489 });
});

test("get_room_rates pages the response with offset and limit", async () => {
  const first = await harness().run({ ...VALID, limit: 2 });
  assert.deepEqual([first.rates.length, first.next_offset], [2, 2]);
  const rest = await harness().run({ ...VALID, limit: 2, offset: 2 });
  assert.deepEqual([rest.rates.map(r => r.room_name), rest.next_offset], [["Example Double"], null]);
  const empty = await harness({ respond: () => ok([]) }).run(VALID);
  assert.deepEqual([empty.status, empty.total, empty.rates], ["no_rates", 0, []]);
});

test("get_room_rates rejects bad input before any request", async () => {
  for (const input of [undefined, {}, { ...VALID, property_id: "ABCD" }, { ...VALID, property_id: "AB-DE" }, { ...VALID, check_in: "2099-02-30" }, { ...VALID, check_out: "2099-03-02" }, { ...VALID, check_out: "2099-05-02" }, { ...VALID, check_in: "2001-01-01", check_out: "2001-01-02" }, { ...VALID, rooms: 0 }, { ...VALID, limit: 151 }, { ...VALID, extra: 1 }]) {
    const h = harness();
    assert.equal((await h.run(input)).error_kind, "invalid_input", JSON.stringify(input));
    assert.equal(h.calls.length, 0);
  }
});

test("get_room_rates turns blocks, unknown hotels and site changes into explicit errors", async () => {
  const unknown = { body: { data: { commerce: { product: { searchProductsByProperty: { __typename: "UserInputError", code: "UNPROCESSABLE_ENTITY", errors: [{ code: "queries.properties", devMessage: "Invalid Property Code", message: "The system has encountered an unexpected error." }], httpStatus: 422 } } } } } };
  const cases = [
    [{ respond: () => unknown }, "invalid_input"],
    [{ respond: () => ({ body: { errors: [{ extensions: { code: "PERSISTED_QUERY_NOT_IN_LIST" } }] } }) }, "site_changed"],
    [{ respond: () => ({ body: { data: { commerce: { product: { searchProductsByProperty: { edges: "x" } } } } } }) }, "site_changed"],
    [{ respond: () => ({ status: 403, body: "<html><title>Access Denied</title></html>" }) }, "challenge"],
    [{ respond: () => ({ status: 429, body: "" }) }, "rate_limited"],
    [{ respond: () => ({ status: 500, body: "oops" }) }, "site_error"],
    [{ throws: true }, "site_error"]
  ];
  for (const [options, kind] of cases) assert.equal((await harness(options).run(VALID)).error_kind, kind, kind);
  const elsewhere = harness({ origin: "https://example.com" });
  assert.equal((await elsewhere.run(VALID)).error_kind, "wrong_page");
  const denied = harness({ title: "Access Denied" });
  assert.equal((await denied.run(VALID)).error_kind, "challenge");
  assert.equal(elsewhere.calls.length + denied.calls.length, 0);
});
