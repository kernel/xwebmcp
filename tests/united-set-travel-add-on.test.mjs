import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const [def] = (0, eval)(readFileSync(new URL("../domains/united.com/set_travel_add_on.js", import.meta.url), "utf8"));

test("united set_travel_add_on: missing confirm returns confirmation_required before touching the page", async () => {
  const r = await def.execute({ add_on_id: "premier_access", selected: true, expected_price: 0, expected_total_due: 100, confirm: false });
  assert.equal(r.status, "confirmation_required");
  assert.ok(def.tool.outputSchema.oneOf[1].properties.status.enum.includes(r.status));
});

test("united set_travel_add_on: malformed input is rejected before touching the page", async () => {
  const r = await def.execute({ add_on_id: "insurance", selected: true, expected_price: 0, expected_total_due: 100, confirm: true });
  assert.equal(r.status, "error");
});

test("united set_travel_add_on: success branch requires total_updated, not_confirmed is gone", () => {
  assert.ok(def.tool.outputSchema.oneOf[0].required.includes("total_updated"));
  assert.ok(!def.tool.outputSchema.oneOf[1].properties.status.enum.includes("not_confirmed"));
});
