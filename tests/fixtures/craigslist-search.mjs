const empty = () => ({
  apiVersion: 8, errors: [],
  data: {
    categoryAbbr: "bia", location: { country: "US", url: "sfbay.craigslist.org" },
    totalResultCount: 0, items: [], decode: 0
  }
});
const offsets = () => ({ version: 2, minPostingId: 7000000000, minPostedDate: 1700000000, locations: [] });
const row = [1, 60, 68, 125, "1:1:1~0~0", "00", [13, "FabricatedListing123"], [6, "example-road-bicycle"], [10, "$125"], "Example road bicycle"];

export function searchCases() {
  const cases = [];
  const add = (name, change, status = "error", error_kind = "site_changed", http_status = 200) => {
    const body = empty(); change(body);
    cases.push({ name, body, status, error_kind: status === "error" ? error_kind : null, http_status });
  };
  add("zero sentinel", () => {}, "no_results");
  add("empty decoding object", b => b.data.decode = {}, "no_results");
  add("valid version two empty batch", b => b.data.decode = offsets(), "no_results");
  add("absent decoding property", b => delete b.data.decode);
  for (const [name, value] of [["null", null], ["false", false], ["true", true], ["array", []], ["string zero", "0"], ["one", 1], ["negative", -1], ["fraction", 0.5], ["unknown version", { version: 3 }], ["version alone", { version: 2 }], ["unknown metadata", { injected: "fixture@example.invalid" }]]) {
    add("decode " + name, b => b.data.decode = value);
  }
  for (const [key, values] of [["minPostingId", [null, 0, -1, "7000000000", 1.5]], ["minPostedDate", [null, -1, "1700000000", 1.5]], ["locations", [null, {}, ""]]]) {
    for (const value of values) add(`invalid ${key} ${JSON.stringify(value)}`, b => { b.data.decode = offsets(); b.data.decode[key] = value; });
  }
  add("total without items", b => b.data.totalResultCount = 1);
  add("items without total", b => b.data.items = [row]);
  add("nonempty zero decoding sentinel", b => { b.data.items = [row]; b.data.totalResultCount = 1; });
  add("nonempty empty decoding object", b => { b.data.items = [row]; b.data.totalResultCount = 1; b.data.decode = {}; });
  add("wrong category", b => b.data.categoryAbbr = "cta");
  add("wrong country", b => b.data.location.country = "CA");
  add("wrong area", b => b.data.location.url = "other.craigslist.org");
  add("wrong API version", b => b.apiVersion = 9);
  add("fractional total", b => b.data.totalResultCount = 0.5);
  add("string total", b => b.data.totalResultCount = "0");
  add("null items", b => b.data.items = null);
  for (const value of [null, false, 0, "", {}, ["fixture@example.invalid"]]) add("malformed or nonempty errors " + JSON.stringify(value), b => b.errors = value);
  add("missing errors", b => delete b.errors);
  for (const [http, kind] of [[400, "invalid_input"], [401, "login_required"], [403, "forbidden"], [429, "rate_limited"], [500, "site_error"]]) add("HTTP " + http, () => {}, "error", kind, http);
  add("populated version two", b => {
    b.data.decode = { ...offsets(), locations: [0, [1, "sfbay", "sfc"]] };
    b.data.items = [row]; b.data.totalResultCount = 1;
  }, "ok");
  return cases;
}
