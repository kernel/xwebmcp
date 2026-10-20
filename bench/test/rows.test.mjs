import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { completePairRows, latestRows, readRows, rowKey } from "../lib/rows.mjs";

test("rows cut short are skipped and the latest row per trial wins", () => {
  const file = join(mkdtempSync(join(tmpdir(), "bench-rows-")), "rows.jsonl");
  const row = (pair, arm, outcome) => JSON.stringify({ intent: "i", pair, adoption: null, arm, outcome });
  writeFileSync(file, [row(1, "control", "aborted"), '{"intent":"i","pair":1,"ar', row(1, "control", "correct"), row(1, "treatment", "wrong"), '{"intent":"i","pa'].join("\n"));
  const rows = readRows(file);
  assert.equal(rows.length, 3);
  assert.deepEqual(latestRows(rows).map(r => `${rowKey(r)}=${r.outcome}`), ["i|1|control=correct", "i|1|treatment=wrong"]);
  assert.deepEqual(readRows(join(file, "..", "missing.jsonl")), []);
  assert.equal(rowKey({ intent: "i", pair: null, adoption: 2, arm: "treatment" }), "i|a2|treatment");
});

test("only pairs with both trials scored count", () => {
  const row = (intent, pair, arm, outcome) => ({ intent, pair, adoption: null, arm, outcome });
  const rows = [
    row("i", 1, "control", "correct"), row("i", 1, "treatment", "wrong"),
    row("i", 2, "control", "correct"), row("i", 2, "treatment", "aborted"),
    row("i", 3, "treatment", "correct"),
    row("j", 1, "control", "timeout"), row("j", 1, "treatment", "correct"),
    { intent: "i", pair: null, adoption: 1, arm: "treatment", outcome: "correct" },
  ];
  assert.deepEqual(completePairRows(rows).map(rowKey), ["i|1|control", "i|1|treatment", "j|1|control", "j|1|treatment"]);
});
