import assert from "node:assert/strict";
import test from "node:test";
import { extractValues } from "../lib/page.mjs";
import { gradeAnswer } from "../grade.mjs";

test("extract patterns read values from the page text, amounts as numbers", () => {
  const text = "Trip Summary\nATL to MCO\nDelta Main Classic\nAmount Due USD $143.40\nFlights $1,120.00";
  assert.deepEqual(extractValues(text, { amount_due: "Amount Due\\s*(?:USD\\s*)?\\$\\s*([\\d,]+\\.\\d{2})", flights: "Flights\\s*(\\$[\\d,.]+)", cabin: "Delta (Main \\w+)", seats: "Seat (\\d+[A-F])" }),
    { amount_due: 143.4, flights: 1120, cabin: "Main Classic" });
  // A group that takes no part in the match is left out, like a pattern that does not match.
  assert.deepEqual(extractValues("Amount Due", { amount_due: "Amount Due(?: \\$([\\d.]+))?" }), {});
});

test("a page check grades the page the agent left, not a tool's reading of it", () => {
  const intent = {
    rules: [], fixture: {},
    check: {
      extract: { amount_due: "Amount Due\\s*(?:USD\\s*)?\\$\\s*([\\d,]+\\.\\d{2})" },
      rules: [{ path: "url", matches: "/trip-summary" }, { path: "text", matches: "Main Classic" }, { path: "extracted.amount_due", range: [1, 3000] }],
      same_as_answer: [{ answer: "amount_due", end_state: "extracted.amount_due" }],
    },
  };
  const schema = { type: "object", required: ["amount_due"], properties: { amount_due: { type: "number" } } };
  const page = (text) => ({ output: { url: "https://www.delta.com/purchase/flights/trip-summary", title: "Trip Summary", text, fields: {}, missing: [], invalid: [] } });
  const answer = '```json\n{"amount_due": 143.4}\n```';
  const correct = gradeAnswer(intent, schema, answer, page("Delta Main Classic\nAmount Due USD $143.40"));
  assert.equal(correct.outcome, "correct");
  assert.deepEqual(correct.end_state_values.extracted, { amount_due: 143.4 });
  assert.match(gradeAnswer(intent, schema, answer, page("Delta Main Classic\nAmount Due USD $151.20")).problems.join(), /amount_due is \[143\.4\] in the answer but extracted\.amount_due is \[151\.2\]/);
  assert.match(gradeAnswer(intent, schema, answer, page("Delta Main Basic\nAmount Due USD $143.40")).problems.join(), /text: .* does not match \/Main Classic\/i/);
  assert.match(gradeAnswer(intent, schema, answer, page("Delta Main Classic")).problems.join(), /extracted\.amount_due: no value/);
});

test("a failing rule on long page text shows only the start of it", () => {
  const intent = { rules: [], fixture: {}, check: { rules: [{ path: "text", matches: "Main Classic" }] } };
  const schema = { type: "object" };
  const grade = gradeAnswer(intent, schema, "```json\n{}\n```", { output: { url: "u", text: "x".repeat(50_000) } });
  assert.ok(grade.problems[0].length < 200, grade.problems[0].length);
});
