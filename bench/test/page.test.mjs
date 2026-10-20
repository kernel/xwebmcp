import assert from "node:assert/strict";
import test from "node:test";
import { extractValues, stepName, stepTimeline } from "../lib/page.mjs";
import { gradeAnswer } from "../grade.mjs";

test("extract patterns read values from the page text, amounts as numbers", () => {
  const text = "Trip Summary\nATL to MCO\nDelta Main Classic\nAmount Due USD $143.40\nFlights $1,120.00";
  assert.deepEqual(extractValues(text, { amount_due: "Amount Due\\s*(?:USD\\s*)?\\$\\s*([\\d,]+\\.\\d{2})", flights: "Flights\\s*(\\$[\\d,.]+)", cabin: "Delta (Main \\w+)", seats: "Seat (\\d+[A-F])" }),
    { amount_due: 143.4, flights: 1120, cabin: "Main Classic" });
  // A group that takes no part in the match is left out, like a pattern that does not match.
  assert.deepEqual(extractValues("Amount Due", { amount_due: "Amount Due(?: \\$([\\d.]+))?" }), {});
});

test("a step is a named URL pattern, or the host and path with ids collapsed", () => {
  const steps = [{ name: "trip summary", url_patterns: ["https://www.delta.com/*/trip-summary*"] }];
  assert.equal(stepName("https://www.delta.com/purchase/flights/trip-summary?cartId=1", steps), "trip summary");
  assert.equal(stepName("https://www.delta.com/flight-search/book-a-flight", steps), "www.delta.com/flight-search/book-a-flight");
  assert.equal(stepName("https://checkout.bluebottlecoffee.com/c/pay/cs_live_a1jRC0N9NNoMSufg5sbZzPf7rVUd"), "checkout.bluebottlecoffee.com/c/pay/*");
  assert.equal(stepName("https://www.etsy.com/listing/1234567890/a-mug"), "www.etsy.com/listing/*/a-mug");
  assert.equal(stepName("https://bluebottlecoffee.com/"), "bluebottlecoffee.com");
});

test("agent time splits at each top-frame navigation, with the calls made on each step", () => {
  const navigations = [
    { ms: -9_000, url: "https://bluebottlecoffee.com/" },
    { ms: 30_000, url: "https://bluebottlecoffee.com/us/eng/product/opascope" },
    { ms: 31_000, url: "about:blank" },
    { ms: 90_000, url: "https://checkout.bluebottlecoffee.com/c/pay/cs_live_a1jRC0N9NNoMSufg5sbZzPf7rVUd" },
    { ms: 100_000, url: "https://bluebottlecoffee.com/us/eng/product/opascope" },
    { ms: 130_000, url: "https://checkout.bluebottlecoffee.com/c/pay/cs_live_b2kSD1O0OOpNTvgh6tcAaQg8sWVe" },
    { ms: 999_000, url: "https://bluebottlecoffee.com/after" },
  ];
  const calls = [{ start_ms: 1_000, invoke: null }, { start_ms: 5_000, invoke: "find_product" }, { start_ms: 40_000, invoke: "add_to_cart" }, { start_ms: 140_000, invoke: null }];
  assert.deepEqual(stepTimeline({ navigations, calls, durationMs: 150_000, startUrl: "https://bluebottlecoffee.com/" }), [
    { step: "bluebottlecoffee.com", ms: 30_000, calls: 2, invocations: ["find_product"] },
    { step: "bluebottlecoffee.com/us/eng/product/opascope", ms: 90_000, calls: 1, invocations: ["add_to_cart"] },
    { step: "checkout.bluebottlecoffee.com/c/pay/*", ms: 30_000, calls: 1, invocations: [] },
  ]);
  // With no navigation at all, the whole run is on the start page.
  assert.deepEqual(stepTimeline({ navigations: [], calls: [], durationMs: 5_000, startUrl: "https://example.com/" }), [{ step: "example.com", ms: 5_000, calls: 0, invocations: [] }]);
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
