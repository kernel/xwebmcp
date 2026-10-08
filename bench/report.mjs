#!/usr/bin/env node
// Builds the markdown scorecard for a run.
// Usage: node bench/report.mjs bench/results/<run_id> > report.md

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { completePairRows, latestRows, readRows } from "./lib/rows.mjs";
import { median, newcombe, signTest, signTestRate, wilson } from "./lib/stats.mjs";
import { resolvePath } from "./grade.mjs";

// The speedup ratios are recalibrated after the pilot.
const THRESHOLDS = { adoption: 0.5, minBothCorrect: 5, p: 0.1, faster: 1.5, slower: 0.67, mixedDelta: 2 };
// Worst first.
const LABELS = ["slower", "mixed", "no adoption", "inconclusive", "no signal", "faster"];
const OUTCOMES = ["correct", "wrong", "malformed", "timeout", "crashed"];

const sum = (values) => values.reduce((a, b) => a + b, 0);

const START_SKEW_MS = 1000;

export function startDelaySkews(rows) {
  const pairs = Map.groupBy(rows.filter(r => r.pair !== null), r => `${r.intent}|${r.pair}`);
  return [...pairs.values()].map(pair => {
    const [control, treatment] = ["control", "treatment"].map(arm => pair.find(r => r.arm === arm)?.start_delay_ms);
    return typeof control === "number" && typeof treatment === "number" ? treatment - control : 0;
  }).filter(skew => Math.abs(skew) > START_SKEW_MS);
}

export function armStats(rows) {
  const correct = rows.filter(r => r.outcome === "correct").map(r => r.duration_ms);
  const all = rows.map(r => r.duration_ms).filter(d => d !== null);
  const invocations = rows.flatMap(r => r.webmcp?.invocations ?? []);
  const withStatus = invocations.filter(i => i.status !== null);
  return {
    n: rows.length,
    correct: correct.length,
    interval: wilson(correct.length, rows.length),
    outcomes: Object.fromEntries(OUTCOMES.map(o => [o, rows.filter(r => r.outcome === o).length])),
    fastest: correct.length ? Math.min(...correct) : null,
    median: median(correct),
    slowest: correct.length ? Math.max(...correct) : null,
    median_all: median(all),
    min_per_correct: correct.length ? sum(all) / 60_000 / correct.length : null,
    adoption: rows.length ? rows.filter(r => r.webmcp?.adopted).length / rows.length : null,
    invocations: invocations.length,
    invoke_success: withStatus.length ? withStatus.filter(i => i.status === "completed").length / withStatus.length : null,
    tool_median: median(withStatus.map(i => i.duration_ms).filter(d => d !== null)),
    turns: median(rows.map(r => r.turns).filter(t => typeof t === "number")),
    tokens_in: median(rows.map(r => r.tokens_in).filter(t => typeof t === "number")),
    cost: median(rows.map(r => r.cost_usd).filter(c => typeof c === "number")),
  };
}

// Strings compare case- and whitespace-insensitively, and objects regardless of key order.
const canonical = (value) => JSON.stringify(value, (key, v) => {
  if (typeof v === "string") return v.trim().toLowerCase().replace(/\s+/g, " ");
  if (v && typeof v === "object" && !Array.isArray(v)) return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)));
  return v;
});

// A pair's trials run back to back, so when both are correct but the best value differs, the
// worse arm missed it; with `same`, differing answers mean one arm was wrong, though not which.
function agreementStats(pairs, { path, better, tolerance = 0, same }) {
  if (same) {
    const values = (row) => JSON.stringify(resolvePath(row.grade?.answer, path).map(canonical).sort());
    return { checked: pairs.length, differed: pairs.filter(p => values(p.control) !== values(p.treatment)).length };
  }
  const value = (row) => resolvePath(row.grade?.answer, path)[0];
  const checked = pairs.filter(p => typeof value(p.control) === "number" && typeof value(p.treatment) === "number");
  const gap = (p) => (value(p.treatment) - value(p.control)) * (better === "lower" ? 1 : -1);
  return {
    checked: checked.length,
    treatment_worse: checked.filter(p => gap(p) > tolerance).length,
    control_worse: checked.filter(p => gap(p) < -tolerance).length,
  };
}

// The speedup and the sign test use the same both-correct pairs, so a treatment answer whose
// control timed out does not shorten the treatment median.
export function pairStats(rows, agreement = null) {
  const byPair = new Map();
  for (const row of rows.filter(r => r.pair !== null)) {
    const key = `${row.intent}|${row.pair}`;
    byPair.set(key, { ...byPair.get(key), [row.arm]: row });
  }
  const both = [...byPair.values()].filter(p => p.control?.outcome === "correct" && p.treatment?.outcome === "correct");
  // Pairs correct in one arm only; an exact McNemar test on them uses the pairing.
  const paired = [...byPair.values()].filter(p => p.control && p.treatment);
  const onlyTreatment = paired.filter(p => p.treatment.outcome === "correct" && p.control.outcome !== "correct").length;
  const onlyControl = paired.filter(p => p.control.outcome === "correct" && p.treatment.outcome !== "correct").length;
  const faster = both.filter(p => p.treatment.duration_ms < p.control.duration_ms).length;
  const slower = both.filter(p => p.treatment.duration_ms > p.control.duration_ms).length;
  const speedup = both.length ? median(both.map(p => p.control.duration_ms)) / median(both.map(p => p.treatment.duration_ms)) : null;
  return {
    both: both.length, faster, slower, p: signTest(faster, faster + slower), speedup, agreement: agreement && agreementStats(both, agreement),
    only_treatment: onlyTreatment, only_control: onlyControl, correct_p: signTest(onlyTreatment, onlyTreatment + onlyControl),
  };
}

export function adoptedPairStats(rows, agreement = null) {
  const key = (row) => `${row.intent}|${row.pair}`;
  const adopted = new Set(rows.filter(r => r.pair !== null && r.arm === "treatment" && r.webmcp?.adopted).map(key));
  return { pairs: adopted.size, ...pairStats(rows.filter(r => adopted.has(key(r))), agreement) };
}

// A rule that only repeats the fixture back pins nothing.
export function answerCheck(intent) {
  const pinned = (intent.rules ?? []).some(rule => ("equals" in rule || "in" in rule) && !JSON.stringify(rule.equals ?? rule.in).includes("{{"));
  return pinned ? "pinned" : intent.agreement ? "agreement" : "shape only";
}

export function compare(control, treatment, pairs, stage) {
  const deltaCorrect = treatment.correct - control.correct;
  const deltaRate = control.n && treatment.n ? treatment.correct / treatment.n - control.correct / control.n : null;
  const { speedup, agreement } = pairs;
  const against = (arm) => {
    if (!agreement) return 0;
    if (agreement.differed !== undefined) return agreement.differed;
    return arm === "treatment" ? agreement.treatment_worse - agreement.control_worse : agreement.control_worse - agreement.treatment_worse;
  };
  const significant = pairs.p !== null && pairs.p < THRESHOLDS.p;
  let label = "no signal";
  if (deltaRate === null) label = "inconclusive";
  else if (stage !== "gap" && treatment.adoption < THRESHOLDS.adoption) label = "no adoption";
  else if (pairs.both < THRESHOLDS.minBothCorrect) label = "inconclusive";
  else if (significant && pairs.faster > pairs.slower && speedup >= THRESHOLDS.faster) {
    label = deltaCorrect <= -THRESHOLDS.mixedDelta || against("treatment") >= THRESHOLDS.mixedDelta ? "mixed" : "faster";
  } else if (significant && pairs.slower > pairs.faster && speedup <= THRESHOLDS.slower) {
    label = deltaCorrect >= THRESHOLDS.mixedDelta || against("control") >= THRESHOLDS.mixedDelta ? "mixed" : "slower";
  }
  return {
    delta_correct: deltaCorrect,
    delta_rate: deltaRate,
    delta_interval: newcombe(treatment.correct, treatment.n, control.correct, control.n),
    speedup,
    delta_min_per_correct: control.min_per_correct !== null && treatment.min_per_correct !== null ? treatment.min_per_correct - control.min_per_correct : null,
    label,
  };
}

// --- formatting -----------------------------------------------------------------------------

const na = "n/a";
const signed = (x, digits = 0) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toFixed(digits)}`;
const pct = (x) => x === null ? na : `${Math.round(x * 100)}%`;
const interval = (iv) => iv ? `[${Math.round(iv[0] * 100)}, ${Math.round(iv[1] * 100)}]` : "";
const signedInterval = (iv) => iv ? `[${signed(iv[0] * 100)}, ${signed(iv[1] * 100)}]` : "";
const ratio = (x) => x === null ? na : `${x.toFixed(1)}×`;
const pValue = (p) => p === null ? na : p.toFixed(3);
const usd = (x) => x === null ? na : `$${x.toFixed(x < 1 ? 3 : 2)}`;
const count = (x) => x === null ? na : String(Math.round(x));
const clock = (ms) => {
  if (ms === null || ms === undefined) return na;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const outcomeText = (counts) => OUTCOMES.filter(o => counts[o]).map(o => `${counts[o]} ${o}`).join(" · ") || "—";
const table = (head, rows) => [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map(r => `| ${r.join(" | ")} |`)].join("\n");

function intentTitle(intent, plan) {
  const source = (s) => `${s.pr ? `#${s.pr}` : s.ref}${s.fetched?.startsWith("refs/pull/") ? " (branch gone, PR head)" : ""} @ ${s.sha.slice(0, 7)}`;
  const sources = plan.sources.map(source).join(" + ");
  const tools = plan.registered ? ` · ${plan.registered.length} tool${plan.registered.length === 1 ? "" : "s"}${plan.drafts?.length ? ` (draft: ${plan.drafts.join(", ")})` : ""}` : "";
  const profile = plan.profile ? ` · signed in with profile ${plan.profile.name}` : "";
  return `${intent.domain} · ${intent.stage} · ${intent.id} · ${sources}${tools}${profile} · answers: ${answerCheck(intent)}`;
}

function prKey(plan) {
  const prs = plan.sources.filter(s => s.pr).map(s => `#${s.pr}`);
  return prs.length ? `${plan.intent.domain} ${prs.join(" + ")}` : `${plan.intent.domain} @ ${plan.sources.map(s => s.ref).join(" + ")}`;
}

export function buildReport(run, allRows, smokeRows = []) {
  const rows = latestRows(allRows);
  const aborted = rows.filter(r => r.outcome === "aborted");
  const pairRows = completePairRows(rows);
  const scored = [...rows.filter(r => r.adoption !== null && r.outcome !== "aborted"), ...pairRows];
  const unpaired = rows.length - aborted.length - scored.length;
  const out = [];
  out.push(`# A/B screening · ${run.run_id}`);
  out.push("");
  const spend = (list) => `$${sum(list.map(r => r.cost_usd ?? 0)).toFixed(2)}`;
  out.push(`model \`${run.model}\`${run.thinking ? ` (thinking ${run.thinking})` : ""} · agent ${run.agent ?? na}${run.kernel_cli ? ` · ${run.kernel_cli}` : ""} · started ${run.created_at} · `
    + `${scored.length} trials scored, ${aborted.length} aborted, ${unpaired} left out because their pair's other trial aborted or has not run · `
    + `spend ${spend(allRows)} over every recorded attempt${smokeRows.length ? `, plus ${spend(smokeRows)} on smoke gates` : ""}`);
  out.push("");
  out.push("Labels are screening labels, not verdicts. Grading checks shape and rules only, so \"correct\" means plausible and "
    + "rule-consistent, not verified against a reference. Δ correct intervals treat the arms as independent samples; trials are "
    + "paired, so the intervals are wider than they need be; the McNemar p under each table uses the pairing.");

  const adoptionRows = scored.filter(r => r.adoption !== null);
  if (adoptionRows.length) {
    out.push("", "## Treatment-only trials", "");
    const domains = [...new Set(adoptionRows.map(r => run.intents[r.intent].intent.domain))];
    out.push(table(["domain", "trials", "invoked a tool", "adoption", "outcomes"], domains.map(domain => {
      const domainRows = adoptionRows.filter(r => run.intents[r.intent].intent.domain === domain);
      const adopted = domainRows.filter(r => r.webmcp?.adopted).length;
      return [domain, domainRows.length, adopted, pct(adopted / domainRows.length), outcomeText(armStats(domainRows).outcomes)];
    })));
  }

  const results = [];
  out.push("", "## Intents");
  for (const plan of Object.values(run.intents)) {
    const { intent } = plan;
    const intentRows = pairRows.filter(r => r.intent === intent.id);
    const leftOut = new Set(rows.filter(r => r.intent === intent.id && r.pair !== null && !intentRows.includes(r)).map(r => r.pair)).size;
    const abortedIn = (arm) => aborted.filter(r => r.intent === intent.id && r.pair !== null && r.arm === arm).length;
    const abortedText = abortedIn("control") || abortedIn("treatment") ? ` (aborted: control ${abortedIn("control")}, treatment ${abortedIn("treatment")})` : "";
    const leftOutText = leftOut ? `${leftOut} pair(s) left out because a trial aborted or has not run${abortedText}.` : "";
    if (!intentRows.length) {
      if (leftOut) out.push("", `### ${intentTitle(intent, plan)}`, "", `no complete pairs; ${leftOutText}`);
      continue;
    }
    const control = armStats(intentRows.filter(r => r.arm === "control"));
    const treatment = armStats(intentRows.filter(r => r.arm === "treatment"));
    const pairs = pairStats(intentRows, intent.agreement ?? null);
    const delta = compare(control, treatment, pairs, intent.stage);
    results.push({ plan, control, treatment, pairs, delta });
    const arm = (name, s, tools) => [name, s.n, `${s.correct} · ${pct(s.n ? s.correct / s.n : null)} ${interval(s.interval)}`, outcomeText(s.outcomes),
      clock(s.fastest), clock(s.median), clock(s.slowest), clock(s.median_all), s.min_per_correct === null ? na : s.min_per_correct.toFixed(1),
      tools ? pct(s.adoption) : "—", tools ? s.invocations : "—", tools ? pct(s.invoke_success) : "—", tools ? clock(s.tool_median) : "—"];
    out.push("", `### ${intentTitle(intent, plan)}`, "");
    out.push(table(["", "n", "correct", "outcomes", "fastest", "median", "slowest", "median_all", "min/correct", "adoption", "invocations", "invoke ok", "tool median"], [
      arm("control", control, false),
      arm("treatment", treatment, true),
      ["Δ", "", delta.delta_rate === null ? na : `${signed(delta.delta_correct)} · ${signed(delta.delta_rate * 100)} pp ${signedInterval(delta.delta_interval)}`,
        "", "", `speedup ${ratio(delta.speedup)}`, "", "", delta.delta_min_per_correct === null ? na : signed(delta.delta_min_per_correct, 1),
        `**${delta.label}**`, "", "", ""],
    ]));
    const unbrowsed = (arm) => intentRows.filter(r => r.arm === arm && r.outcome === "correct" && r.tool_calls === 0).length;
    const unbrowsedText = unbrowsed("control") || unbrowsed("treatment") ? ` Correct without any tool call: control ${unbrowsed("control")}, treatment ${unbrowsed("treatment")}.` : "";
    const oneArm = pairs.only_treatment || pairs.only_control
      ? ` Correct in one arm only: treatment in ${pairs.only_treatment} pairs, control in ${pairs.only_control}, exact McNemar p = ${pValue(pairs.correct_p)}.` : "";
    out.push("", `pairs: treatment faster in ${pairs.faster} of ${pairs.both} both-correct pairs, p = ${pValue(pairs.p)}.${oneArm}${leftOutText ? ` ${leftOutText}` : ""}${unbrowsedText}`);
    out.push("", `per trial, median: turns ${count(control.turns)} control, ${count(treatment.turns)} treatment; input tokens ${count(control.tokens_in)} and ${count(treatment.tokens_in)}; `
      + `cost ${usd(control.cost)} and ${usd(treatment.cost)}.`);
    if (treatment.adoption > 0 && treatment.adoption < 1) {
      const used = adoptedPairStats(intentRows);
      out.push("", `treatment invoked a tool in ${used.pairs} of ${treatment.n} pairs; in the ${used.both} of those where both arms were correct, `
        + `treatment was faster in ${used.faster}, speedup ${ratio(used.speedup)}. These pairs are picked by what the agent did, so they are not a randomized comparison.`);
    }
    if (pairs.agreement?.differed !== undefined) {
      out.push("", `${intent.agreement.path} has one right answer: in ${pairs.agreement.checked} both-correct pairs, the arms' answers differed in ${pairs.agreement.differed}.`);
    } else if (pairs.agreement) {
      const { checked, treatment_worse: tw, control_worse: cw } = pairs.agreement;
      out.push("", `${intent.agreement.path}, ${intent.agreement.better} is better: in ${checked} both-correct pairs, treatment's was worse in ${tw} and control's in ${cw}.`);
    }
  }

  if (results.length) {
    out.push("", "## By PR");
    const groups = Map.groupBy(results, r => prKey(r.plan));
    for (const [key, group] of groups) {
      const labelled = group.filter(r => r.plan.intent.stage !== "gap").map(r => r.delta.label);
      const worst = LABELS.find(label => labelled.includes(label)) ?? na;
      out.push("", `### ${key} · worst label: **${worst}**`, "");
      out.push(table(["intent", "stage", "answers", "label", "Δ correct", "speedup", "adoption", "invocations", "invoke ok", "tool median"], group.map(r => [
        r.plan.intent.id, r.plan.intent.stage, answerCheck(r.plan.intent), r.delta.label, signed(r.delta.delta_correct), ratio(r.delta.speedup),
        pct(r.treatment.adoption), r.treatment.invocations, pct(r.treatment.invoke_success), clock(r.treatment.tool_median),
      ])));
    }

    out.push("", "## Run", "");
    const labelled = results.filter(r => r.plan.intent.stage !== "gap");
    out.push(`labels: ${LABELS.map(label => `${label} ${labelled.filter(r => r.delta.label === label).length}`).join(" · ")}`);
    const unchecked = labelled.filter(r => answerCheck(r.plan.intent) === "shape only" && ["faster", "slower"].includes(r.delta.label));
    if (unchecked.length) {
      out.push("", `${unchecked.length} faster or slower label(s) come from intents whose answers are checked by shape only (${unchecked.map(r => r.plan.intent.id).join(", ")}): `
        + "there an arm that answers quickly but incompletely still counts as correct.");
    }
    const speedups = labelled.map(r => r.delta.speedup).filter(s => s !== null);
    out.push("", `median speedup across ${speedups.length} intents: ${speedups.length ? `${ratio(median(speedups))} (range ${ratio(Math.min(...speedups))} to ${ratio(Math.max(...speedups))})` : na}`);
    const gap = results.filter(r => r.plan.intent.stage === "gap");
    if (gap.length) {
      const c = gap.reduce((a, r) => ({ k: a.k + r.control.correct, n: a.n + r.control.n }), { k: 0, n: 0 });
      const t = gap.reduce((a, r) => ({ k: a.k + r.treatment.correct, n: a.n + r.treatment.n }), { k: 0, n: 0 });
      const faster = sum(gap.map(r => r.pairs.faster));
      const slower = sum(gap.map(r => r.pairs.slower));
      const rate = t.n && c.n ? t.k / t.n - c.k / c.n : null;
      const gapDelta = rate === null ? na : `${signed(rate * 100)} pp ${signedInterval(newcombe(t.k, t.n, c.k, c.n))}`;
      out.push("", `placebo (${gap.length} gap intents pooled): Δ correct ${gapDelta}; treatment faster in ${faster} of ${faster + slower} `
        + `both-correct pairs, p = ${pValue(signTest(faster, faster + slower))}. Gap intents still get the domain's tools, none of which `
        + "covers them, so expected Δ is zero; a consistent difference here comes from registration itself, not from a tool that fits the task.");
    }
    const totals = (arm) => {
      const armRows = pairRows.filter(r => r.arm === arm);
      return `${Math.round(sum(armRows.map(r => r.duration_ms ?? 0)) / 60_000)} agent-minutes, ${sum(armRows.map(r => r.turns ?? 0))} turns and ${spend(armRows)}`;
    };
    out.push("", `over complete pairs: control ${totals("control")}; treatment ${totals("treatment")}.`);
    const [controlFirst, treatmentFirst] = ["AB", "BA"].map(order => pairStats(pairRows.filter(r => r.order === order)));
    out.push("", `order check: treatment faster in ${controlFirst.faster} of ${controlFirst.both} both-correct pairs that ran control first, `
      + `and in ${treatmentFirst.faster} of ${treatmentFirst.both} that ran treatment first. A large gap means a pair's first trial affects its second.`);
    const skews = startDelaySkews(pairRows);
    if (skews.length) {
      const largest = Math.max(...skews.map(Math.abs));
      out.push("", `start delay check: in ${skews.length} pair(s) the arms' agents launched more than ${START_SKEW_MS / 1000}s apart after their `
        + `pages loaded, treatment later in ${skews.filter(s => s > 0).length}, by up to ${(largest / 1000).toFixed(1)}s. Registration that `
        + "outlasts the start delay gives the treatment's page longer to settle.");
    }
    const native = pairRows.filter(r => r.arm === "control" && r.native_tools?.length);
    if (native.length) {
      const byIntent = Map.groupBy(native, r => r.intent);
      out.push("", `native tools check: ${native.length} control trial(s) started with the page's own WebMCP tools (`
        + `${[...byIntent].map(([intent, list]) => `${intent}: ${[...new Set(list.flatMap(r => r.native_tools))].join(", ")}`).join("; ")}), `
        + "which both arms can use, so there the comparison is the registered tools against the site's own, not against none.");
    }
    const slowest = results.filter(r => r.control.slowest !== null).sort((a, b) => b.control.slowest - a.control.slowest)[0];
    if (slowest) out.push("", `cap calibration: slowest correct control trial ${clock(slowest.control.slowest)} (${slowest.plan.intent.id}); cap ${clock(slowest.plan.cap_sec * 1000)}.`);
    const noise = sum(labelled.filter(r => r.pairs.both >= THRESHOLDS.minBothCorrect).map(r => signTestRate(r.pairs.both, THRESHOLDS.p)));
    out.push("", `Under no true effect, the sign test alone reaches p < ${THRESHOLDS.p} on about ${noise.toFixed(1)} of these ${labelled.length} `
      + "intents, so up to that many faster or slower labels may be noise.");
  }

  const flagged = rows.filter(r => r.outcome === "aborted" || r.outcome === "crashed" || r.registration_changed);
  if (flagged.length) {
    out.push("", "## Trials to look at", "");
    out.push(table(["intent", "trial", "arm", "outcome", "registration changed", "reason"], flagged.map(r => [
      r.intent, r.pair !== null ? `pair ${r.pair}` : `adoption ${r.adoption}`, r.arm, r.outcome, r.registration_changed ? "yes" : "", (r.reason ?? "").replace(/\|/g, "\\|"),
    ])));
  }
  return out.join("\n") + "\n";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const runDir = process.argv[2];
  if (!runDir) {
    console.error("usage: node bench/report.mjs bench/results/<run_id>");
    process.exit(2);
  }
  const run = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
  process.stdout.write(buildReport(run, readRows(join(runDir, "rows.jsonl")), readRows(join(runDir, "smoke.jsonl"))));
}
