import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkRule, checkSameAsAnswer, extractAnswer, extractFeedback, gradeAnswer, resolvePath } from "../grade.mjs";
import { fill } from "../lib/intents.mjs";

const benchDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const schema = {
  type: "object",
  required: ["ip", "country_code", "asn"],
  properties: {
    ip: { type: "string" },
    country_code: { type: "string", pattern: "^[A-Z]{2}$" },
    asn: { type: "string", pattern: "^AS[0-9]+$" },
  },
};
const intent = { fixture: { ip: "8.8.8.8" }, rules: [{ path: "ip", equals: "{{ip}}" }] };

test("answers are extracted from a fenced block, a trailing object, or key-value prose", () => {
  const expected = { ip: "8.8.8.8", country_code: "US", asn: "AS15169" };
  assert.deepEqual(extractAnswer('Done.\n```json\n{"ip": "8.8.8.8", "country_code": "US", "asn": "AS15169"}\n```', schema), expected);
  assert.deepEqual(extractAnswer('Here it is: {"ip": "8.8.8.8", "country_code": "US", "asn": "AS15169"}', schema), expected);
  assert.deepEqual(extractAnswer("Result:\n- **ip**: 8.8.8.8\n- country code: `US`\n- ASN: AS15169\n- note: Google", schema), expected);
  // Prose numbers lose their currency sign and thousands separators.
  const fare = { type: "object", properties: { price: { type: "number" }, departure_time: { type: "string" } } };
  assert.deepEqual(extractAnswer("- **Price:** $1,234.50.\n- departure time: 07:05", fare), { price: 1234.5, departure_time: "07:05" });
  assert.equal(extractAnswer("I could not find it.", schema), null);
  assert.equal(extractAnswer("", schema), null);
  assert.deepEqual(extractAnswer('```json\n{"ip": "1.1.1.1"}\n```\nCorrection:\n```json\n{"ip": "8.8.8.8"}\n```', schema), { ip: "8.8.8.8" });
});

test("the first failing step decides the outcome", () => {
  const grade = (text) => gradeAnswer(intent, schema, text);
  assert.equal(grade("no idea").outcome, "malformed");
  const wrongShape = grade('{"ip": "8.8.8.8", "country_code": "USA", "asn": "AS15169"}');
  assert.deepEqual([wrongShape.outcome, wrongShape.extracted, wrongShape.shape], ["wrong", true, false]);
  const wrongRule = grade('{"ip": "8.8.4.4", "country_code": "US", "asn": "AS15169"}');
  assert.deepEqual([wrongRule.outcome, wrongRule.shape, wrongRule.rules], ["wrong", true, false]);
  const correct = grade('{"ip": "8.8.8.8", "country_code": "US", "asn": "AS15169"}');
  assert.deepEqual([correct.outcome, correct.rules], ["correct", true]);
});

test("paths step into arrays with []", () => {
  const answer = { films: [{ title: "A", showtimes: ["10:00", "12:30"] }, { title: "B", showtimes: ["19:15"] }] };
  assert.deepEqual(resolvePath(answer, "films[].showtimes[]"), ["10:00", "12:30", "19:15"]);
  assert.deepEqual(resolvePath(answer, "films[].title"), ["A", "B"]);
  assert.deepEqual(resolvePath(answer, "films[].missing"), []);
});

test("rule checks", () => {
  const answer = {
    theaters: [{ name: "AMC 34th Street 14", time: "18:30" }, { name: "Regal Times Square", time: "19:00" }],
    quantity: 2, date: "2026-10-13", amounts: [25, 50, 50],
  };
  assert.equal(checkRule({ path: "theaters", count: [2, 2] }, answer), null);
  assert.match(checkRule({ path: "theaters", count: [3, 3] }, answer), /count outside/);
  assert.equal(checkRule({ path: "theaters[].name", unique: true }, answer), null);
  assert.match(checkRule({ path: "amounts[]", unique: true }, answer), /not unique/);
  assert.equal(checkRule({ path: "theaters[].time", range: ["17:00", "23:59"] }, answer), null);
  assert.match(checkRule({ path: "theaters[].time", range: ["18:45", "23:59"] }, answer), /outside/);
  assert.equal(checkRule({ path: "theaters[].time", time: true }, answer), null);
  assert.match(checkRule({ path: "date", time: true }, answer), /not an HH:MM time/);
  assert.equal(checkRule({ path: "date", date: true }, answer), null);
  assert.match(checkRule({ path: "date", date: true }, { date: "2026-02-30" }), /not a calendar date/);
  assert.match(checkRule({ path: "date", date: true }, { date: "2026-10-07T10:00:00Z" }), /not a calendar date/);
  assert.equal(checkRule({ path: "theaters[].name", matches: "34th|times square" }, answer), null);
  assert.equal(checkRule({ path: "theaters[0]", equals: "x" }, answer), "theaters[0]: no value");
  assert.equal(checkRule({ path: "quantity", equals: 2 }, answer), null);
  assert.equal(checkRule({ path: "theaters[].name", in: ["amc 34th street 14", "REGAL  times square"] }, answer), null);
});

test("fixture placeholders keep the fixture value's type when they are the whole string", () => {
  assert.deepEqual(fill({ equals: "{{n}}", text: "PR #{{n}} in {{repo}}" }, { n: 43109, repo: "a/b" }), { equals: 43109, text: "PR #43109 in a/b" });
  assert.equal(fill("{{constructor}}", {}), "{{constructor}}");
});

test("a matches rule takes fixture values literally", () => {
  const intent = { fixture: { film: "Verity (2026)" }, rules: [{ path: "film", matches: "^{{film}}$" }] };
  const grade = (film) => gradeAnswer(intent, { type: "object" }, JSON.stringify({ film })).outcome;
  assert.equal(grade("verity (2026)"), "correct");
  assert.equal(grade("Verity 2026"), "wrong");
});

test("a prepare intent is correct only when the end state passes its check", () => {
  const prepare = { ...intent, check: { rules: [{ path: "step", equals: "trip_summary" }, { path: "slices[].origin", matches: "ATL" }] } };
  const text = '{"ip": "8.8.8.8", "country_code": "US", "asn": "AS15169"}';
  const grade = (endState) => gradeAnswer(prepare, schema, text, endState);
  assert.deepEqual([grade({ output: { step: "trip_summary", slices: [{ origin: "ATL" }] } }).outcome, grade({ output: { step: "trip_summary", slices: [{ origin: "ATL" }] } }).end_state], ["correct", true]);
  const elsewhere = grade({ output: { step: "other", slices: [] } });
  assert.deepEqual([elsewhere.outcome, elsewhere.end_state, elsewhere.problems], ["wrong", false, ['end state: step: "other" is not "trip_summary"', "end state: slices[].origin: no value"]]);
  assert.equal(gradeAnswer(intent, schema, text).end_state, null);
});

test("a prepare intent's answer must report what the runner read on the page", () => {
  const prepare = { ...intent, check: { rules: [], same_as_answer: [{ answer: "asn", end_state: "connection.asn" }, { answer: "ip", end_state: "ips[]" }] } };
  const text = '{"ip": "8.8.8.8", "country_code": "US", "asn": "AS15169"}';
  const grade = (output) => gradeAnswer(prepare, schema, text, { output });
  assert.equal(grade({ connection: { asn: "as 15169" }, ips: ["8.8.8.8"] }).outcome, "correct");
  const elsewhere = grade({ connection: { asn: "AS15170" }, ips: ["8.8.8.8"] });
  assert.deepEqual([elsewhere.outcome, elsewhere.end_state, elsewhere.problems], ["wrong", false, ['end state: asn is ["as15169"] in the answer but connection.asn is ["as15170"] on the site']]);
  assert.equal(grade({ connection: { asn: "AS15169" }, ips: [] }).outcome, "wrong");
});

test("amounts match to the cent", () => {
  assert.equal(checkSameAsAnswer({ answer: "total", end_state: "amount_due" }, { total: 143.4 }, { amount_due: 143.40000001 }), null);
  assert.match(checkSameAsAnswer({ answer: "total", end_state: "amount_due" }, { total: 143.4 }, { amount_due: 150.2 }), /\[143\.4\] in the answer but amount_due is \[150\.2\]/);
  assert.match(checkSameAsAnswer({ answer: "total", end_state: "amount_due" }, { total: 143.4 }, { amount_due: null }), /\[null\] on the site/);
});

test("the espresso checkout grades the fields read from the page", () => {
  const intent = JSON.parse(readFileSync(join(benchDir, "tasks/bluebottlecoffee.com/bluebottle-checkout-espresso.json"), "utf8"));
  const espressoSchema = JSON.parse(readFileSync(join(benchDir, intent.answer_schema), "utf8"));
  const page = {
    url: "https://checkout.bluebottlecoffee.com/c/pay/cs_live_x", missing: [], invalid: [],
    fields: { email: "webmcp-demo@example.com", name: "Alex Demo", address: "500 Sansome Street", city: "San Francisco", zip: "94111", state: "CA", phone: "(415) 555-0123", card_number: "4242 4242 4242 4242", card_expiry: "08 / 31", card_cvc: "500" },
  };
  const grade = (output) => gradeAnswer(intent, espressoSchema, '{"product": "Opascope Espresso", "quantity": 1}', { output });
  assert.deepEqual(grade(page).problems, []);
  assert.equal(grade({ ...page, fields: { ...page.fields, phone: "+1 415-555-0123" } }).outcome, "correct");
  assert.match(grade({ ...page, fields: { ...page.fields, card_number: "4000 0000 0000 0002" } }).problems[0], /card_number/);
  assert.match(grade({ ...page, invalid: ["card_cvc"] }).problems[0], /invalid: count outside/);
  assert.match(grade({ ...page, url: "https://bluebottlecoffee.com/us/eng" }).problems[0], /url/);
});

test("a tool_feedback block is kept out of the answer, wherever it is", () => {
  const feedback = '```json\n{"tool_feedback": [{"tool": "search", "outcome": "succeeded", "reason": "ok", "suggested_change": ""}]}\n```';
  const answer = '```json\n{"price": 5}\n```';
  for (const text of [`${feedback}\n${answer}`, `${answer}\n${feedback}`]) {
    assert.deepEqual(extractAnswer(text, schema), { price: 5 });
    assert.equal(extractFeedback(text)[0].tool, "search");
  }
  assert.equal(extractFeedback(answer), null);
});
