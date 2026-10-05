import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const load = name => readFileSync(new URL(`../domains/delta.com/${name}.js`, import.meta.url), "utf8");

function navigate(url = "https://www.delta.com/us/en/baggage/overview") {
  const assigned = [];
  const scheduled = [];
  const context = {
    URL,
    location: { href: url, assign: to => assigned.push(to) },
    setTimeout: fn => { scheduled.push(fn); return 0; }
  };
  const [tool] = runInNewContext(`(${load("navigate_to_page")})`, context);
  return { tool, run: input => tool.execute(input), assigned, scheduled };
}

test("navigate_to_page: schedules same-origin navigation after returning", async () => {
  const n = navigate();
  const out = await n.run({ url: "/flightsearch/book-a-flight?tripType=ONE_WAY" });
  assert.equal(out.status, "navigation_scheduled");
  assert.equal(out.to_url, "https://www.delta.com/flightsearch/book-a-flight?tripType=ONE_WAY");
  assert.equal(n.assigned.length, 0, "must not navigate before settling");
  n.scheduled[0]();
  assert.deepEqual(n.assigned, [out.to_url]);
});

for (const url of ["https://evil.example/", "//evil.example/x", "flightsearch", "/\\evil.example", ""]) {
  test(`navigate_to_page: rejects ${JSON.stringify(url)} without navigating`, async () => {
    const n = navigate();
    const out = await n.run({ url });
    assert.equal(out.status, "error");
    assert.equal(n.scheduled.length, 0);
  });
}

test("navigate_to_page: description carries a basic site map with examples", () => {
  const { tool } = navigate();
  for (const path of ["/flightsearch/book-a-flight", "/my-trips/search", "/flightstatus/search"]) assert.ok(tool.tool.description.includes(path));
  assert.match(tool.tool.description, /Example: navigate_to_page/);
});
