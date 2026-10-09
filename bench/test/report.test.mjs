import assert from "node:assert/strict";
import test from "node:test";
import { adoptedPairStats, answerCheck, armStats, buildReport, compare, pairStats, startDelaySkews, stepCoverage, toolFailures } from "../report.mjs";
import { newcombe, signTest, signTestRate, wilson } from "../lib/stats.mjs";

const round = (iv) => iv.map(x => Math.round(x * 100));

test("intervals and the sign test match the worked example", () => {
  assert.deepEqual(round(wilson(7, 10)), [40, 89]);
  assert.deepEqual(round(wilson(9, 10)), [60, 98]);
  assert.deepEqual(round(newcombe(9, 10, 7, 10)), [-16, 51]);
  assert.equal(signTest(7, 7).toFixed(3), "0.016");
  assert.equal(signTest(5, 10), 1);
});

test("the sign test's rate under no effect follows from its threshold", () => {
  // p < 0.1 needs all 5 of 5 pairs one way, all 7 of 7, or at most 1 of 10 the other way.
  const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} is not ${expected}`);
  close(signTestRate(5, 0.1), 2 / 32);
  close(signTestRate(7, 0.1), 2 / 128);
  close(signTestRate(10, 0.1), 22 / 1024);
  assert.equal(signTestRate(0, 0.1), 0);
});

// Control: 7 correct, 1 wrong, 1 malformed, 1 timeout. Treatment: 9 correct, 1 timeout,
// faster in all 7 both-correct pairs.
function exampleRows() {
  const control = [[108, "correct"], [150, "correct"], [170, "correct"], [185, "correct"], [200, "correct"], [250, "correct"], [298, "correct"], [210, "wrong"], [190, "malformed"], [600, "timeout"]];
  const treatment = [41, 50, 60, 70, 72, 80, 100, 120, 151].map(s => [s, "correct"]).concat([[600, "timeout"]]);
  const row = (arm, pair, [seconds, outcome], adopted) => ({
    intent: "fandango-theater-showtimes", arm, pair, adoption: null, outcome, duration_ms: seconds * 1000,
    webmcp: { listed: adopted, adopted, paths: adopted ? ["mcp"] : [], invocations: adopted ? [{ path: "mcp", tool: "get_theater_showtimes", status: "completed", duration_ms: 30_000 }] : [] },
    cost_usd: 0.4, registration_changed: false,
  });
  return [
    ...control.map((t, i) => row("control", i + 1, t, false)),
    ...treatment.map((t, i) => row("treatment", i + 1, t, i !== 9)),
  ];
}

test("labels follow the screening rules", () => {
  const arm = (correct, n, adoption = 1) => ({ correct, n, adoption });
  const pairs = (faster, slower, speedup = 185 / 72, agreement = null) => ({ both: faster + slower, faster, slower, p: signTest(faster, faster + slower), speedup, agreement });
  assert.equal(compare(arm(7, 10), arm(9, 10, 0.4), pairs(7, 0), "inspect").label, "no adoption");
  assert.equal(compare(arm(7, 10), arm(9, 10, 0), pairs(7, 0), "gap").label, "faster");
  assert.equal(compare(arm(4, 10), arm(4, 10), pairs(4, 0), "inspect").label, "inconclusive");
  assert.equal(compare(arm(9, 10), arm(7, 10), pairs(7, 0), "inspect").label, "mixed");
  assert.equal(compare(arm(9, 10), arm(9, 10), pairs(0, 9, 72 / 185), "inspect").label, "slower");
  assert.equal(compare(arm(9, 10), arm(9, 10), pairs(9, 0, 100 / 80), "inspect").label, "no signal");
  assert.equal(compare(arm(9, 10), arm(9, 10), pairs(6, 3), "inspect").label, "no signal");
  assert.equal(compare(arm(5, 5), { correct: 0, n: 0, adoption: null }, pairs(0, 0, null), "inspect").label, "inconclusive");
  // Two trials worse is mixed whatever the rates are, including 7/10 and 5/10, whose difference
  // is not exactly 0.2 in floating point.
  assert.equal(compare(arm(7, 10), arm(5, 10), pairs(5, 0), "inspect").label, "mixed");
  assert.equal(compare(arm(8, 10), arm(7, 10), pairs(7, 0), "inspect").label, "faster");
  // Slower but correct in two more trials is mixed too.
  assert.equal(compare(arm(7, 10), arm(9, 10), pairs(0, 7, 72 / 185), "inspect").label, "mixed");
  assert.equal(compare(arm(8, 10), arm(9, 10), pairs(0, 7, 72 / 185), "inspect").label, "slower");
  // At the thresholds: 50% adoption is enough, and so is a speedup of 1.5 (0.67 for slower).
  assert.equal(compare(arm(9, 10), arm(9, 10, 0.5), pairs(7, 0), "inspect").label, "faster");
  assert.equal(compare(arm(9, 10), arm(9, 10), pairs(7, 0, 1.5), "inspect").label, "faster");
  assert.equal(compare(arm(9, 10), arm(9, 10), pairs(0, 7, 0.67), "inspect").label, "slower");
  // Faster but with the worse answer in two more pairs than control is mixed too.
  const agreement = (treatment_worse, control_worse) => ({ checked: 7, treatment_worse, control_worse });
  assert.equal(compare(arm(7, 7), arm(7, 7), pairs(7, 0, 185 / 72, agreement(2, 0)), "find").label, "mixed");
  assert.equal(compare(arm(7, 7), arm(7, 7), pairs(7, 0, 185 / 72, agreement(2, 1)), "find").label, "faster");
  assert.equal(compare(arm(7, 7), arm(7, 7), pairs(0, 7, 72 / 185, agreement(0, 2)), "find").label, "mixed");
  // Answers that should be the same but differed count against whichever arm is favoured.
  const differed = (n) => ({ checked: 7, differed: n });
  assert.equal(compare(arm(7, 7), arm(7, 7), pairs(7, 0, 185 / 72, differed(2)), "find").label, "mixed");
  assert.equal(compare(arm(7, 7), arm(7, 7), pairs(0, 7, 72 / 185, differed(2)), "find").label, "mixed");
  assert.equal(compare(arm(7, 7), arm(7, 7), pairs(7, 0, 185 / 72, differed(1)), "find").label, "faster");
});

test("the speedup comes from the same both-correct pairs as the sign test", () => {
  const row = (arm, pair, seconds, outcome) => ({ intent: "x", arm, pair, adoption: null, outcome, duration_ms: seconds * 1000, webmcp: { adopted: arm === "treatment", invocations: [] } });
  const rows = [];
  // Treatment is 10% faster in five both-correct pairs, and answers quickly in five pairs where
  // control timed out. Those five must not make it look 1.8× faster.
  for (let pair = 1; pair <= 5; pair++) rows.push(row("control", pair, 100 + pair, "correct"), row("treatment", pair, (100 + pair) / 1.1, "correct"));
  for (let pair = 6; pair <= 10; pair++) rows.push(row("control", pair, 600, "timeout"), row("treatment", pair, 20, "correct"));
  const pairs = pairStats(rows);
  assert.equal(pairs.speedup.toFixed(2), "1.10");
  const delta = compare(armStats(rows.filter(r => r.arm === "control")), armStats(rows.filter(r => r.arm === "treatment")), pairs, "inspect");
  assert.equal(delta.label, "no signal");
});

test("agreement counts the pairs where one arm's answer was worse", () => {
  const row = (arm, pair, price) => ({ intent: "x", arm, pair, adoption: null, outcome: "correct", duration_ms: 1000, grade: { answer: { price } } });
  const rows = [
    row("control", 1, 89), row("treatment", 1, 89.5),
    row("control", 2, 89), row("treatment", 2, 129),
    row("control", 3, 149), row("treatment", 3, 89),
    { ...row("control", 4, 89), grade: null }, row("treatment", 4, 89),
  ];
  assert.deepEqual(pairStats(rows, { path: "price", better: "lower", tolerance: 1 }).agreement, { checked: 3, treatment_worse: 1, control_worse: 1 });
  assert.deepEqual(pairStats(rows, { path: "price", better: "higher" }).agreement, { checked: 3, treatment_worse: 1, control_worse: 2 });
  assert.equal(pairStats(rows).agreement, null);
});

test("same agreement counts the pairs whose answers differ as sets", () => {
  const row = (arm, pair, issues) => ({ intent: "x", arm, pair, adoption: null, outcome: "correct", duration_ms: 1000, grade: { answer: { issues } } });
  const rows = [
    // Order, key order and case do not matter.
    row("control", 1, [{ number: 2, has_linked_pr: true }, { number: 1, has_linked_pr: false }]),
    row("treatment", 1, [{ has_linked_pr: false, number: 1 }, { number: 2, has_linked_pr: true }]),
    row("control", 2, [{ number: 1, has_linked_pr: false }]), row("treatment", 2, [{ number: 1, has_linked_pr: true }]),
    row("control", 3, [{ number: 1, has_linked_pr: false }]), row("treatment", 3, [{ number: 3, has_linked_pr: false }]),
  ];
  assert.deepEqual(pairStats(rows, { path: "issues[]", same: true }).agreement, { checked: 3, differed: 2 });
  const names = (arm, pair, repositories) => ({ ...row(arm, pair), grade: { answer: { repositories } } });
  assert.deepEqual(pairStats([names("control", 1, ["Puppeteer/Puppeteer", "a/b"]), names("treatment", 1, ["a/b ", "puppeteer/puppeteer"])], { path: "repositories[]", same: true }).agreement, { checked: 1, differed: 0 });
});

test("the report renders intents, rollups and the latest row per trial", () => {
  const rows = exampleRows();
  rows.unshift({ ...rows[0], outcome: "aborted", reason: "kernel browsers create: boom", duration_ms: null });
  const run = {
    run_id: "pilot-test", model: "openai/test-model", thinking: null, agent: "pi 0", created_at: "2026-10-07T00:00:00Z",
    intents: {
      "fandango-theater-showtimes": {
        intent: { id: "fandango-theater-showtimes", domain: "fandango.com", stage: "inspect" },
        sources: [{ repo: "kernel/xwebmcp", ref: "hypeship/fandango-showtimes", pr: 58, sha: "305b68d0000000000000000000000000000000000" }],
        cap_sec: 600,
      },
    },
  };
  const report = buildReport(run, rows);
  assert.match(report, /### fandango\.com · inspect · fandango-theater-showtimes · #58 @ 305b68d · answers: shape only/);
  // median_all and min/correct count every trial, with the timeout at its full cap.
  assert.match(report, /\| control \| 10 \| 7 · 70% \[40, 89\] \| 7 correct · 1 wrong · 1 malformed · 1 timeout \| 1:48 \| 3:05 \| 4:58 \| 3:15 \| 5\.6 \|/);
  assert.match(report, /\| treatment \| 10 \| 9 · 90% \[60, 98\] \| 9 correct · 1 timeout \| 0:41 \| 1:12 \| 2:31 \| 1:16 \| 2\.5 \|/);
  assert.match(report, /\| Δ \|  \| \+2 · \+20 pp \[−16, \+51\] \|  \|  \| speedup 2\.6× \|  \|  \| −3\.1 \|/);
  assert.match(report, /\*\*faster\*\*/);
  assert.match(report, /treatment faster in 7 of 7 both-correct pairs, p = 0\.016/);
  assert.match(report, /### fandango\.com #58 · worst label: \*\*faster\*\*/);
  assert.match(report, /20 trials scored, 0 aborted, 0 left out/);
  assert.doesNotMatch(report, /without any tool call/);
  assert.match(report, /spend \$8\.40 over every recorded attempt\n/);
  assert.match(report, /the sign test alone reaches p < 0\.1 on about 0\.0 of these 1 intents/);
  assert.match(report, /treatment invoked a tool in 9 of 10 pairs; in the 7 of those where both arms were correct, treatment was faster in 7, speedup 2\.6×, sign test p = 0\.016\./);
  assert.match(report, /1 faster or slower label\(s\) come from intents whose answers are checked by shape only \(fandango-theater-showtimes\)/);
  assert.match(buildReport(run, rows, [{ cost_usd: 0.01 }, { cost_usd: 0.02 }]), /spend \$8\.40 over every recorded attempt, plus \$0\.03 on smoke gates/);
  run.intents["fandango-theater-showtimes"].sources[0].fetched = "refs/pull/58/head";
  assert.match(buildReport(run, rows), /fandango-theater-showtimes · #58 \(branch gone, PR head\) @ 305b68d/);
});

test("a trial that aborted takes its pair's other trial out of both arms", () => {
  const rows = exampleRows();
  // Pair 2's treatment aborted on its last attempt; pair 1's control aborted and then ran again.
  rows.push({ ...rows[11], outcome: "aborted", reason: "setup", duration_ms: null, cost_usd: 0.1 });
  rows.unshift({ ...rows[0], outcome: "aborted", reason: "setup", duration_ms: null, cost_usd: 0 });
  const run = {
    run_id: "t", model: "m", thinking: null, agent: "pi 0", created_at: "2026-10-07T00:00:00Z",
    intents: { "fandango-theater-showtimes": { intent: { id: "fandango-theater-showtimes", domain: "fandango.com", stage: "inspect" }, sources: [{ ref: "main", sha: "0".repeat(40) }], registered: ["a", "b"], drafts: ["b"], cap_sec: 600 } },
  };
  const report = buildReport(run, rows);
  assert.match(report, /18 trials scored, 1 aborted, 1 left out/);
  assert.match(report, /\| control \| 9 \|/);
  assert.match(report, /\| treatment \| 9 \|/);
  assert.match(report, /1 pair\(s\) left out because a trial aborted or has not run \(aborted: control 0, treatment 1\)\./);
  assert.match(report, /· 2 tools \(draft: b\)/);
  assert.match(report, /spend \$8\.10 over every recorded attempt/);
});

test("gap intents are pooled into the placebo check and kept out of the labels", () => {
  const rows = exampleRows();
  // The gap intent: control correct in all 5 pairs, treatment in 3, and faster in those 3.
  const gap = (arm, pair, seconds, outcome) => ({ intent: "fandango-gift-card-amounts", arm, pair, adoption: null, outcome, duration_ms: seconds * 1000, webmcp: { adopted: false, invocations: [] }, cost_usd: 0.1 });
  for (let pair = 1; pair <= 5; pair++) rows.push(gap("control", pair, 100, "correct"), gap("treatment", pair, 50, pair <= 3 ? "correct" : "wrong"));
  const plan = (id, stage) => ({ intent: { id, domain: "fandango.com", stage }, sources: [{ ref: "main", sha: "0".repeat(40) }], cap_sec: 600 });
  const run = {
    run_id: "t", model: "m", thinking: null, agent: "pi 0", created_at: "2026-10-07T00:00:00Z",
    intents: { "fandango-theater-showtimes": plan("fandango-theater-showtimes", "inspect"), "fandango-gift-card-amounts": plan("fandango-gift-card-amounts", "gap") },
  };
  const report = buildReport(run, rows);
  assert.match(report, /placebo \(1 gap intents pooled\): Δ correct −40 pp \[−\d+, \+\d+\]; treatment faster in 3 of 3 both-correct pairs, p = 0\.250\./);
  // The gap intent's own label (inconclusive) counts in neither the PR's worst label nor the run's.
  assert.match(report, /### fandango\.com @ main · worst label: \*\*faster\*\*/);
  assert.match(report, /labels: slower 0 · mixed 0 · no adoption 0 · inconclusive 0 · no signal 0 · faster 1\n/);
  assert.match(report, /on about 0\.0 of these 1 intents/);
});

test("a PR's rollup shows the worst label among its intents", () => {
  const rows = exampleRows();
  // A second intent on the same PR with one both-correct pair is inconclusive, which is worse than faster.
  const other = (arm) => ({ intent: "fandango-nearest-theaters", arm, pair: 1, adoption: null, outcome: "correct", duration_ms: 60_000, webmcp: { adopted: true, invocations: [] } });
  rows.push(other("control"), other("treatment"));
  const plan = (id) => ({ intent: { id, domain: "fandango.com", stage: "inspect" }, sources: [{ ref: "hypeship/fandango-showtimes", pr: 58, sha: "0".repeat(40) }], cap_sec: 600 });
  const run = {
    run_id: "t", model: "m", thinking: null, agent: "pi 0", created_at: "2026-10-07T00:00:00Z",
    intents: { "fandango-theater-showtimes": plan("fandango-theater-showtimes"), "fandango-nearest-theaters": plan("fandango-nearest-theaters") },
  };
  const report = buildReport(run, rows);
  assert.match(report, /\| fandango-theater-showtimes \| inspect \| shape only \| faster \|/);
  assert.match(report, /### fandango\.com #58 · worst label: \*\*inconclusive\*\*/);
});

test("the start delay check flags pairs whose agents launched more than 1s apart", () => {
  const rows = exampleRows().map(r => ({ ...r, start_delay_ms: 10_000 }));
  rows[10].start_delay_ms = 13_500;
  rows[1].start_delay_ms = 11_200;
  rows[12].start_delay_ms = 10_900;
  rows[13].start_delay_ms = null;
  assert.deepEqual(startDelaySkews(rows), [3_500, -1_200]);
  const run = {
    run_id: "t", model: "m", thinking: null, agent: "pi 0", created_at: "2026-10-07T00:00:00Z",
    intents: { "fandango-theater-showtimes": { intent: { id: "fandango-theater-showtimes", domain: "fandango.com", stage: "inspect" }, sources: [{ ref: "main", sha: "0".repeat(40) }], cap_sec: 600 } },
  };
  assert.match(buildReport(run, rows), /start delay check: in 2 pair\(s\) the arms' agents launched more than 1s apart after their pages loaded, treatment later in 1, by up to 3\.5s\./);
  assert.doesNotMatch(buildReport(run, exampleRows()), /start delay check/);
});

test("the native tools check names control trials that started with the page's own tools", () => {
  const rows = exampleRows().map(r => ({ ...r, native_tools: [] }));
  rows[0].native_tools = ["search"];
  rows[2].native_tools = ["search", "get_cart"];
  rows[10].native_tools = ["search"];
  const run = {
    run_id: "t", model: "m", thinking: null, agent: "pi 0", created_at: "2026-10-07T00:00:00Z",
    intents: { "fandango-theater-showtimes": { intent: { id: "fandango-theater-showtimes", domain: "fandango.com", stage: "inspect" }, sources: [{ ref: "main", sha: "0".repeat(40) }], cap_sec: 600 } },
  };
  assert.match(buildReport(run, rows), /native tools check: 2 control trial\(s\) started with the page's own WebMCP tools \(fandango-theater-showtimes: search, get_cart\)/);
  assert.doesNotMatch(buildReport(run, exampleRows()), /native tools check/);
});

test("the report checks run order and counts answers given without a tool call", () => {
  const rows = exampleRows().map(r => ({ ...r, order: r.pair % 2 ? "AB" : "BA", tool_calls: 5 }));
  rows[0].tool_calls = 0;
  rows[10].tool_calls = 0;
  rows[11].tool_calls = 0;
  // A second intent with the same pair numbers must not merge into the first one's pairs.
  const other = [rows[0], rows[10]].map(r => ({ ...r, intent: "other", tool_calls: 5 }));
  const run = {
    run_id: "t", model: "m", thinking: null, agent: "pi 0", created_at: "2026-10-07T00:00:00Z",
    intents: { "fandango-theater-showtimes": { intent: { id: "fandango-theater-showtimes", domain: "fandango.com", stage: "inspect" }, sources: [{ ref: "main", sha: "0".repeat(40) }], profile: { name: "bench-fandango", id: "x" }, cap_sec: 600 } },
  };
  const report = buildReport(run, [...rows, ...other]);
  assert.match(report, /Correct without any tool call: control 1, treatment 2\./);
  assert.match(report, /order check: treatment faster in 5 of 5 both-correct pairs that ran control first, and in 3 of 3 that ran treatment first/);
  assert.match(report, /signed in with profile bench-fandango/);
});

test("an intent's answers are pinned, compared across arms, or checked by shape only", () => {
  assert.equal(answerCheck({ rules: [{ path: "ip", equals: "{{ip}}" }, { path: "asn", equals: "AS37153" }] }), "pinned");
  assert.equal(answerCheck({ rules: [{ path: "repositories[]", in: ["a/b"] }] }), "pinned");
  assert.equal(answerCheck({ rules: [{ path: "date", equals: "{{date}}" }], agreement: { path: "films[]", same: true } }), "agreement");
  assert.equal(answerCheck({ rules: [{ path: "price", range: [1, 3000] }] }), "shape only");
});

test("pairs whose treatment invoked a tool are compared on their own", () => {
  const rows = exampleRows();
  // Pair 1's treatment never invoked a tool.
  rows[10].webmcp = { ...rows[10].webmcp, adopted: false };
  const used = adoptedPairStats(rows);
  assert.deepEqual([used.pairs, used.both, used.faster], [8, 6, 6]);
});

test("the report gives a paired test of correctness and each arm's turns, tokens and cost", () => {
  const rows = exampleRows().map(r => ({ ...r, turns: r.arm === "control" ? 12 : 5, tokens_in: r.arm === "control" ? 90_000 : 40_000 }));
  const pairs = pairStats(rows);
  // Pairs 8 and 9: treatment correct, control wrong or malformed. Pair 10 timed out in both.
  assert.deepEqual([pairs.only_treatment, pairs.only_control, pairs.correct_p], [2, 0, 0.5]);
  // A treatment trial whose control has not run stays out of the totals.
  rows.push({ ...rows[19], pair: 11 });
  const run = {
    run_id: "t", model: "m", thinking: null, agent: "pi 0", created_at: "2026-10-07T00:00:00Z",
    intents: { "fandango-theater-showtimes": { intent: { id: "fandango-theater-showtimes", domain: "fandango.com", stage: "inspect" }, sources: [{ ref: "main", sha: "0".repeat(40) }], cap_sec: 600 } },
  };
  const report = buildReport(run, rows);
  assert.match(report, /Correct in one arm only: treatment in 2 pairs, control in 0, exact McNemar p = 0\.500\./);
  assert.match(report, /per trial, median: turns 12 control, 5 treatment; input tokens 90000 and 40000; cost \$0\.400 and \$0\.400\./);
  assert.match(report, /over complete pairs: control 39 agent-minutes, 120 turns and \$4\.00; treatment 22 agent-minutes, 50 turns and \$4\.00\./);
});

test("tool failures are counted per tool, with the most common errors first", () => {
  const invocation = (tool, status, tool_status, error) => ({ path: "mcp", tool, status, tool_status, error, duration_ms: 1 });
  const rows = [
    { intent: "d", arm: "treatment", webmcp: { invocations: [invocation("search", "error", null, "schema"), invocation("search", "completed", "ok", null), invocation("read", "completed", null, null)] } },
    { intent: "d", arm: "treatment", webmcp: { invocations: [invocation("search", "completed", "error", "UI_CHANGED"), invocation("search", "completed", "error", "UI_CHANGED"), invocation("read", "no_result", null, null)] } },
    { intent: "d", arm: "control", webmcp: { invocations: [invocation("search", "error", null, "control never counts")] } },
  ];
  // Tools with the most failures come first, and an invocation without an error message is listed by its status.
  assert.deepEqual(toolFailures(rows, () => "x.com"), [
    { tool: "x.com/search", calls: 4, failed: 3, errors: [["UI_CHANGED", 2], ["schema", 1]] },
    { tool: "x.com/read", calls: 2, failed: 1, errors: [["no_result", 1]] },
  ]);
  // A tool that returned status "error" does not count toward invoke ok.
  assert.equal(armStats(rows.filter(r => r.arm === "treatment")).invoke_success, 2 / 6);

  const reportRows = exampleRows();
  reportRows[10].webmcp = { adopted: true, invocations: [invocation("get_theater_showtimes", "completed", "error", "UI_CHANGED"), { path: "playwright", tool: null, status: null, tool_status: null, error: null, duration_ms: null }] };
  const run = {
    run_id: "t", model: "m", thinking: null, agent: "pi 0", created_at: "2026-10-07T00:00:00Z",
    intents: { "fandango-theater-showtimes": { intent: { id: "fandango-theater-showtimes", domain: "fandango.com", stage: "inspect" }, sources: [{ ref: "main", sha: "0".repeat(40) }], cap_sec: 600 } },
  };
  assert.match(buildReport(run, reportRows), /in scored treatment trials\. 1 invocation\(s\) made through Playwright or the REPL have no recorded result and are not counted\.\n\n\| tool \|[^\n]*\n[^\n]*\n\| fandango\.com\/get_theater_showtimes \| 9 \| 1 \| 1× UI_CHANGED \|/);
});

test("steps show where each arm spent its time and which steps treatment covered with a tool", () => {
  const step = (name, seconds, invocations = []) => ({ step: name, ms: seconds * 1000, calls: invocations.length + 1, invocations });
  const rows = exampleRows().map(r => ({
    ...r,
    steps: r.arm === "control" ? [step("www.fandango.com", 20), step("www.fandango.com/theater/*", 60)] : [step("www.fandango.com", 5, ["search_theaters"]), step("www.fandango.com/theater/*", 40)],
  }));
  const { trials, steps } = stepCoverage(rows.filter(r => r.pair <= 9));
  assert.deepEqual(trials, { control: 9, treatment: 9 });
  assert.deepEqual(steps.map(s => [s.step, s.control_ms, s.treatment_ms, s.invoked, s.tools]), [
    ["www.fandango.com/theater/*", 60_000, 40_000, 0, []],
    ["www.fandango.com", 20_000, 5_000, 9, ["search_theaters"]],
  ]);
  const run = {
    run_id: "t", model: "m", thinking: null, agent: "pi 0", created_at: "2026-10-07T00:00:00Z",
    intents: {
      "fandango-theater-showtimes": { intent: { id: "fandango-theater-showtimes", domain: "fandango.com", stage: "inspect" }, sources: [{ ref: "main", sha: "0".repeat(40) }], cap_sec: 600 },
      "newsite-task": { intent: { id: "newsite-task", domain: "newsite.com", stage: "find" }, sources: [{ ref: "main", sha: "0".repeat(40) }], cap_sec: 600, uncovered: true },
    },
  };
  const uncovered = [1, 2].map(pair => ({ intent: "newsite-task", arm: "control", pair, adoption: null, outcome: "correct", duration_ms: 90_000, cost_usd: 0.1, steps: [step("newsite.com/search", 70), step("newsite.com", 20)] }));
  const report = buildReport(run, [...rows, ...uncovered]);
  assert.match(report, /\| www\.fandango\.com\/theater\/\* \| 60s \| 40s \| 0 of 10 \| — \|/);
  assert.match(report, /## Tasks with no tools yet[\s\S]*\| newsite-task \| 2 \| 2 \| 2 correct \| 1:30 \| newsite\.com\/search 70s, newsite\.com 20s \|/);
  // The backlog lists the uncovered task's slow step and the step treatment drove without a tool, longest first.
  const backlog = report.slice(report.indexOf("## Tool backlog"));
  assert.match(backlog, /\| newsite-task \| newsite\.com\/search \| 70s \| no tools \| — \|\n\| fandango-theater-showtimes \| www\.fandango\.com\/theater\/\* \| 60s \| 40s \| 0 of 10 \|/);
  assert.doesNotMatch(backlog, /\| www\.fandango\.com \|/);
  assert.match(report, /22 trials scored/);
});
