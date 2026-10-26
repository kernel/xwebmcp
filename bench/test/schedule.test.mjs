import assert from "node:assert/strict";
import test from "node:test";
import { randomInt } from "node:crypto";
import { setImmediate as tick } from "node:timers/promises";
import { completePairRows, latestRows, rowKey } from "../lib/rows.mjs";
import { adoptionVerdicts, balancedOrders, holdNeededSec, nextJob, pairArms, planJobs, runPairAttempts, runQueue } from "../lib/schedule.mjs";

const jobs = (...secs) => secs.map(sec => ({ sec, profile: null }));

test("the hold covers each stage in turn, including its longest job", () => {
  assert.equal(holdNeededSec([jobs(100, 100), jobs(400)], 1), 600);
  // Three slots: 1200/3 plus two thirds of the longest job, then the second stage.
  assert.equal(holdNeededSec([jobs(300, 300, 300, 300), jobs(600, 600, 600)], 3), 1200 / 3 + 200 + 1800 / 3 + 400);
  assert.equal(holdNeededSec([[], jobs(60)], 2), 30 + 30);
});

test("jobs on one profile run one at a time, and the hold covers them in a row", () => {
  const onProfile = [{ sec: 300, profile: "p" }, { sec: 300, profile: "p" }, { sec: 300, profile: "p" }];
  assert.equal(holdNeededSec([onProfile], 3), 900);
  // Two on the profile take 600s in a row, less than the stage's 1800/3 plus two thirds of 300.
  assert.equal(holdNeededSec([[...onProfile.slice(1), ...jobs(300, 300, 300, 300)]], 3), 1800 / 3 + 200);
  const queue = [{ profile: "p" }, { profile: "p" }, { profile: null }, { profile: "q" }];
  assert.equal(nextJob(queue, new Set()), 0);
  assert.equal(nextJob(queue, new Set(["p"])), 2);
  assert.equal(nextJob(queue.slice(0, 2), new Set(["p"])), -1);
});

test("a domain stops when no treatment-only trial invoked a tool, including when all aborted", () => {
  const row = (domain, outcome, adopted) => ({ domain, outcome, webmcp: outcome === "aborted" ? null : { adopted } });
  const rows = [
    row("a.com", "correct", true), row("a.com", "wrong", false),
    row("b.com", "correct", false), row("b.com", "aborted"),
    row("c.com", "aborted"), row("c.com", "aborted"),
  ];
  assert.deepEqual(adoptionVerdicts(["a.com", "b.com", "c.com", "d.com"], rows).map(v => [v.domain, v.trials, v.aborted, v.adopted, v.stop]), [
    ["a.com", 2, 0, 1, false],
    ["b.com", 2, 1, 0, true],
    ["c.com", 2, 2, 0, true],
    ["d.com", 0, 0, 0, false],
  ]);
});

test("pair orders split evenly between AB and BA, in random sequence", () => {
  const count = (orders, order) => orders.filter(o => o === order).length;
  for (let i = 0; i < 50; i++) {
    const ten = balancedOrders(10, randomInt);
    assert.deepEqual([count(ten, "AB"), count(ten, "BA")], [5, 5]);
    const five = balancedOrders(5, randomInt);
    assert.equal(Math.abs(count(five, "AB") - count(five, "BA")), 1);
  }
  assert.deepEqual(balancedOrders(1, () => 1), ["BA"]);
  assert.deepEqual(balancedOrders(3, () => 0), ["BA", "AB", "AB"]);
});

const intentPlan = (id, domain, orders, { stage = "find", fixture = {} } = {}) => ({ intent: { id, domain, stage, fixture }, orders });
const latestOf = (rows) => new Map(latestRows(rows).map(row => [rowKey(row), row]));
const pairRow = (intent, pair, arm, outcome) => ({ intent, pair, adoption: null, arm, outcome });

test("pairs are interleaved across intents, and a pair runs again unless both trials are scored", () => {
  const plans = [intentPlan("a", "x.com", ["AB", "BA", "AB"]), intentPlan("b", "x.com", ["BA"])];
  const latest = latestOf([
    pairRow("a", 1, "control", "correct"), pairRow("a", 1, "treatment", "timeout"),
    pairRow("a", 2, "control", "correct"), pairRow("a", 2, "treatment", "aborted"),
    pairRow("b", 1, "treatment", "correct"),
  ]);
  const { pairJobs, adoptionJobs, stale } = planJobs(plans, 0, latest, "2026-10-07");
  assert.deepEqual(pairJobs.map(j => `${j.intentPlan.intent.id}${j.pair}${j.order}`), ["b1BA", "a2BA", "a3AB"]);
  assert.deepEqual([adoptionJobs, stale], [[], []]);
});

test("treatment-only trials cycle through a domain's non-gap intents, interleave across domains and skip scored ones", () => {
  const plans = [intentPlan("a", "x.com", []), intentPlan("g", "x.com", [], { stage: "gap" }), intentPlan("b", "x.com", []), intentPlan("c", "y.com", [])];
  const latest = latestOf([{ intent: "b", pair: null, adoption: 2, arm: "treatment", outcome: "wrong" }, { intent: "c", pair: null, adoption: 1, arm: "treatment", outcome: "aborted" }]);
  const { adoptionJobs } = planJobs(plans, 3, latest, "2026-10-07");
  assert.deepEqual(adoptionJobs.map(j => `${j.intentPlan.intent.id}${j.adoption}`), ["a1", "c1", "c2", "a3", "c3"]);
});

test("an intent whose fixture dates have passed loses its remaining jobs", () => {
  const plans = [intentPlan("old", "x.com", ["AB", "BA"], { fixture: { date: "2026-10-06" } }), intentPlan("new", "x.com", ["AB"], { fixture: { date: "2026-10-07" } })];
  const done = latestOf([pairRow("old", 1, "control", "correct"), pairRow("old", 1, "treatment", "correct")]);
  const { pairJobs, stale } = planJobs(plans, 1, done, "2026-10-07");
  assert.deepEqual(pairJobs.map(j => `${j.intentPlan.intent.id}${j.pair}`), ["new1"]);
  assert.deepEqual(stale.map(s => [s.intentPlan.intent.id, s.dates]), [["old", ["date 2026-10-06"]]]);
  // Nothing left to skip: a finished stale intent is not reported.
  const finished = latestOf([...["control", "treatment"].flatMap(arm => [1, 2].map(pair => pairRow("old", pair, arm, "correct")))]);
  assert.deepEqual(planJobs([plans[0]], 0, finished, "2026-10-07").stale, []);
});

async function scriptedPair(arms, outcomes) {
  const rows = [];
  const script = [...outcomes];
  await runPairAttempts(arms, 2, async (arm, attempt) => {
    const outcome = script.shift();
    if (outcome !== null) rows.push({ ...pairRow("i", 1, arm, outcome), attempt });
    return outcome;
  });
  return { rows, unused: script.length };
}

test("an aborted trial runs its pair again whole, and a complete pair comes from one attempt", async () => {
  const cases = [
    [["correct", "correct"], 2, true],
    [["correct", "aborted", "wrong", "correct"], 4, true],
    [["aborted", "correct", "timeout"], 3, true],
    [["correct", "aborted", "correct", "aborted"], 4, false],
    [["aborted", "aborted"], 2, false],
    [["correct", null], 1, false],
    [["correct", "aborted", "correct", null], 3, false],
  ];
  for (const [outcomes, written, complete] of cases) {
    const { rows } = await scriptedPair(["control", "treatment"], outcomes);
    assert.equal(rows.length, written, JSON.stringify(outcomes));
    for (const group of Map.groupBy(rows, r => r.attempt).values()) assert.deepEqual(group.map(r => r.arm), ["control", "treatment"].slice(0, group.length));
    const pair = completePairRows(latestRows(rows));
    assert.equal(pair.length === 2, complete, JSON.stringify(outcomes));
    if (complete) assert.equal(new Set(pair.map(r => r.attempt)).size, 1, JSON.stringify(outcomes));
  }
});

const recordingJobs = (profiles, log, failing = []) => profiles.map((profile, i) => ({
  profile,
  run: async () => {
    log.push(`start ${i}`);
    for (let n = 0; n < 3; n++) await tick();
    log.push(`end ${i}`);
    if (failing.includes(i)) throw new Error(`job ${i} failed`);
  },
}));

test("the queue runs jobs on one profile one at a time while other jobs fill the free slots", async () => {
  const log = [];
  assert.deepEqual(await runQueue(recordingJobs(["p", "p", null, "p"], log), 3), { refused: false });
  assert.deepEqual(log.filter(l => /[013]$/.test(l)), ["start 0", "end 0", "start 1", "end 1", "start 3", "end 3"]);
  assert.ok(log.indexOf("start 2") < log.indexOf("end 0"));
});

test("once a job is refused no more start, and the running ones finish", async () => {
  const log = [];
  const admit = () => log.filter(l => l.startsWith("start")).length < 3;
  assert.deepEqual(await runQueue(recordingJobs([null, null, null, null], log), 2, { admit }), { refused: true });
  assert.deepEqual(log.filter(l => l.startsWith("start")), ["start 0", "start 1", "start 2"]);
  assert.equal(log.filter(l => l.startsWith("end")).length, 3);
});

test("a job that throws releases its profile, and beforeJob can stop the queue", async () => {
  const log = [];
  await assert.rejects(runQueue(recordingJobs(["p", "p"], log, [0]), 2), /job 0 failed/);
  for (let n = 0; n < 10; n++) await tick();
  assert.deepEqual(log, ["start 0", "end 0", "start 1", "end 1"]);
  let checks = 0;
  const beforeJob = () => { if (++checks > 1) throw new Error("too many aborts"); };
  await assert.rejects(runQueue(recordingJobs([null, null], []), 1, { beforeJob }), /too many aborts/);
  assert.equal(checks, 2);
});

test("a treatment-only pair is its treatment trial, and a domain without tools still runs control", () => {
  assert.deepEqual(pairArms({ treatment_only: true }, "AB"), ["treatment"]);
  assert.deepEqual(pairArms({ treatment_only: true, uncovered: true }, "AB"), ["control"]);
  assert.deepEqual(pairArms({}, "BA"), ["treatment", "control"]);
});
