import assert from "node:assert/strict";
import test from "node:test";
import { checkRule, extractAnswer, gradeAnswer, resolvePath } from "../grade.mjs";
import { fill } from "../lib/intents.mjs";

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
  const prepare = { ...intent, check: { tool: "get_trip_summary", rules: [{ path: "step", equals: "trip_summary" }, { path: "slices[].origin", matches: "ATL" }] } };
  const text = '{"ip": "8.8.8.8", "country_code": "US", "asn": "AS15169"}';
  const grade = (endState) => gradeAnswer(prepare, schema, text, endState);
  assert.deepEqual([grade({ output: { step: "trip_summary", slices: [{ origin: "ATL" }] } }).outcome, grade({ output: { step: "trip_summary", slices: [{ origin: "ATL" }] } }).end_state], ["correct", true]);
  const elsewhere = grade({ output: { step: "other", slices: [] } });
  assert.deepEqual([elsewhere.outcome, elsewhere.end_state, elsewhere.problems], ["wrong", false, ['end state: step: "other" is not "trip_summary"', "end state: slices[].origin: no value"]]);
  assert.deepEqual(grade({ error: "get_trip_summary is not live" }).problems, ["end state: get_trip_summary is not live"]);
  assert.equal(gradeAnswer(intent, schema, text).end_state, null);
});
